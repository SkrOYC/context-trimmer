import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const ARCHIVE_TYPE = "results-archive";

export interface ArchivedResult {
  pointerId: string;
  toolName: string;
  toolCallId: string;
  parameterKey: string;      // Resolved absolute or relative file path
  timestamp: number;
  originalContent: string;   // JSON-serialized tool result content
  startLine: number;         // 1-indexed starting line
  lineHashes: string[];      // SHA-256 hashes of each read line
}

export interface ToolPolicy {
  toolName: string;
  getParameterKey: (input: Record<string, any>) => string | undefined;
  shouldArchive: (content: string) => boolean;
}

const POLICIES: ToolPolicy[] = [
  {
    toolName: "read",
    getParameterKey: (input) => input.AbsolutePath || input.path,
    shouldArchive: (content) => content.length > 2000,
  }
];

function getHash(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

export function checkStaleness(arc: ArchivedResult, cwd: string): boolean {
  try {
    const filePath = path.isAbsolute(arc.parameterKey)
      ? arc.parameterKey
      : path.resolve(cwd, arc.parameterKey);

    if (!fs.existsSync(filePath)) {
      return true;
    }

    const diskContent = fs.readFileSync(filePath, "utf8");
    const diskLines = diskContent.split(/\r?\n/);

    const startLine = arc.startLine;
    const lineHashes = arc.lineHashes;

    for (let i = 0; i < lineHashes.length; i++) {
      const lineIndex = startLine - 1 + i;
      const diskLine = diskLines[lineIndex];
      if (diskLine === undefined) {
        return true;
      }
      if (getHash(diskLine) !== lineHashes[i]) {
        return true;
      }
    }

    return false;
  } catch {
    return true; // Fallback to stale on read failure
  }
}

export default function (pi: ExtensionAPI) {
  // Reconstructed branch state
  let activeArchives = new Map<string, ArchivedResult>();

  function rebuildState(ctx: ExtensionContext) {
    activeArchives.clear();
    const branch = ctx.sessionManager.getBranch();

    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === ARCHIVE_TYPE) {
        const arc = entry.data as ArchivedResult;
        if (arc && arc.pointerId) {
          activeArchives.set(arc.pointerId, arc);
        }
      }
    }
  }

  // Session state lifecycle hooks
  pi.on("session_start", (_, ctx) => rebuildState(ctx));
  pi.on("session_tree", (_, ctx) => rebuildState(ctx));

  // Intercept and record tool results without modifying the raw output
  pi.on("tool_result", async (event, ctx) => {
    const policy = POLICIES.find(p => p.toolName === event.toolName);
    if (!policy) return;

    const contentStr = event.content.map(c => c.type === "text" ? (c.text || "") : "").join("\n");
    // Payloads above 1MB are skipped
    if (contentStr.length > 1024 * 1024) return;
    if (!policy.shouldArchive(contentStr)) return;

    try {
      rebuildState(ctx);

      const paramKey = policy.getParameterKey(event.input) || "default";
      const offset = Number(event.input.offset) || 1;
      const lineHashes = contentStr.split(/\r?\n/).map(line => getHash(line));

      const pointerId = `ptr_${Math.random().toString(36).substring(2, 10)}`;
      const archiveRecord: ArchivedResult = {
        pointerId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        parameterKey: paramKey,
        timestamp: Date.now(),
        originalContent: JSON.stringify(event.content),
        startLine: offset,
        lineHashes
      };

      pi.appendEntry<ArchivedResult>(ARCHIVE_TYPE, archiveRecord);

      // Return undefined so the tool result goes to the model in full initially
      return undefined;
    } catch (err) {
      console.warn("[Context Trimmer] Failed to archive read result:", err);
      return;
    }
  });

  // Rewrite context before sending to the LLM
  pi.on("context", async (event, ctx) => {
    try {
      rebuildState(ctx);

      const updated = event.messages.map(msg => {
        if (msg.role !== "toolResult") return msg;
        
        // Find if this toolResult has a matching archive record
        const arc = Array.from(activeArchives.values()).find(
          a => a.toolCallId === msg.toolCallId
        );

        if (!arc) return msg;

        // Verify if the referenced file lines on disk have changed
        const isStale = checkStaleness(arc, ctx.cwd);
        if (isStale) {
          return {
            ...msg,
            content: [{
              type: "text" as const,
              text: `[Results Archive: ${arc.pointerId} (Invalidated - Stale)]`
            }]
          };
        }

        return msg;
      });

      return { messages: updated };
    } catch (err) {
      console.warn("[Context Trimmer] Failed to process context hooks:", err);
      return;
    }
  });

  // Register Recall Tool for LLM
  pi.registerTool({
    name: "recall_result",
    label: "Recall Result",
    description: "Retrieve complete or older tool result payloads from the results archive.",
    parameters: Type.Object({
      pointer_id: Type.String({ description: "The pointer ID, e.g. ptr_abc123" })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
        rebuildState(ctx);

        const pointerId = params.pointer_id;
        const arc = activeArchives.get(pointerId);

        if (!arc) {
          return {
            content: [{ type: "text", text: `Error: Pointer ${pointerId} not found in this branch.` }],
            isError: true,
            details: { status: "not_found" }
          } as any;
        }

        const isStale = checkStaleness(arc, ctx.cwd);
        const originalContent = JSON.parse(arc.originalContent);

        if (isStale) {
          return {
            content: [{ type: "text", text: `Warning: Pointer ${pointerId} was invalidated. Content is stale.` }],
            details: { originalContent, status: "invalidated" }
          };
        }

        return {
          content: originalContent,
          details: { status: "active" }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error recalling result: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
          details: { status: "error" }
        } as any;
      }
    }
  });
}