import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ARCHIVE_TYPE = "results-archive";
const INVALIDATE_TYPE = "invalidation-event";

export interface ArchivedResult {
  pointerId: string;
  toolName: string;
  toolCallId: string;
  parameterKey: string;      // Normalized target resource key (e.g., "/absolute/path")
  timestamp: number;
  originalContent: string;   // The raw redacted output
  metadata: {
    policyName: string;
    characterCount: number;
  };
}

export interface InvalidationEvent {
  supersededPointerId: string;
  triggerToolCallId: string;
  reason: string;
  timestamp: number;
}

export interface ToolPolicy {
  toolName: string;
  /** Matches tool parameters to extract a resource key */
  getParameterKey: (input: Record<string, any>) => string | undefined;
  /** Decides whether a result should be archived */
  shouldArchive: (content: string, details?: any) => boolean;
  /** If true, newer results for the same parameter key invalidate older ones */
  invalidatePrior: boolean;
}

const POLICIES: ToolPolicy[] = [
  {
    toolName: "read",
    getParameterKey: (input) => input.AbsolutePath || input.path,
    shouldArchive: (content) => content.length > 2000,
    invalidatePrior: true
  },
  {
    toolName: "grep",
    getParameterKey: (input) => `${input.SearchPath}:${input.Query}`,
    shouldArchive: (content) => content.length > 4000,
    invalidatePrior: false
  }
];

export default function (pi: ExtensionAPI) {
  // Reconstructed branch state
  let activeArchives = new Map<string, { entry: ArchivedResult; invalidated: boolean }>();
  let targetToPointer = new Map<string, string>(); // targetKey -> pointerId

  function rebuildState(ctx: ExtensionContext) {
    activeArchives.clear();
    targetToPointer.clear();

    const branch = ctx.sessionManager.getBranch();
    const archives = new Map<string, ArchivedResult>();
    const invalidations = new Set<string>();

    for (const entry of branch) {
      if (entry.type === "custom") {
        if (entry.customType === ARCHIVE_TYPE) {
          const arc = entry.data as ArchivedResult;
          if (arc && arc.pointerId) {
            archives.set(arc.pointerId, arc);
            if (arc.parameterKey) {
              targetToPointer.set(`${arc.toolName}:${arc.parameterKey}`, arc.pointerId);
            }
          }
        } else if (entry.customType === INVALIDATE_TYPE) {
          const inv = entry.data as InvalidationEvent;
          if (inv && inv.supersededPointerId) {
            invalidations.add(inv.supersededPointerId);
          }
        }
      }
    }

    for (const [pointerId, arc] of archives.entries()) {
      activeArchives.set(pointerId, {
        entry: arc,
        invalidated: invalidations.has(pointerId)
      });
    }
  }

  // Session state lifecycle hooks
  pi.on("session_start", (_, ctx) => rebuildState(ctx));
  pi.on("session_tree", (_, ctx) => rebuildState(ctx));

  // Intercept and archive tool results
  pi.on("tool_result", async (event, ctx) => {
    const policy = POLICIES.find(p => p.toolName === event.toolName);
    if (!policy) return;

    const contentStr = JSON.stringify(event.content);
    // Payload above 1MB are skipped
    if (contentStr.length > 1024 * 1024) return;
    if (!policy.shouldArchive(contentStr, event.details)) return;

    try {
      rebuildState(ctx);

      const paramKey = policy.getParameterKey(event.input) || "default";
      const targetKey = `${event.toolName}:${paramKey}`;

      // Handle invalidation of older pointer targeting same resource
      if (policy.invalidatePrior) {
        const priorPointerId = targetToPointer.get(targetKey);
        if (priorPointerId && !activeArchives.get(priorPointerId)?.invalidated) {
          pi.appendEntry<InvalidationEvent>(INVALIDATE_TYPE, {
            supersededPointerId: priorPointerId,
            triggerToolCallId: event.toolCallId,
            reason: `Superseded by execution of ${event.toolName} (ID: ${event.toolCallId})`,
            timestamp: Date.now()
          });
        }
      }

      const pointerId = `ptr_${Math.random().toString(36).substring(2, 10)}`;
      const archiveRecord: ArchivedResult = {
        pointerId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        parameterKey: paramKey,
        timestamp: Date.now(),
        originalContent: contentStr,
        metadata: {
          policyName: `${event.toolName}-archive-policy`,
          characterCount: contentStr.length
        }
      };

      pi.appendEntry<ArchivedResult>(ARCHIVE_TYPE, archiveRecord);

      return {
        content: [{ type: "text" as const, text: `[Results Archive: ${pointerId}]` }]
      };
    } catch (err) {
      console.warn("[Context Trimmer] Failed to prune context, bypassing:", err);
      return;
    }
  });

  // Rewrite context before sending to the LLM
  pi.on("context", async (event, ctx) => {
    try {
      rebuildState(ctx);

      const updated = event.messages.map(msg => {
        if (msg.role !== "toolResult") return msg;
        
        const updatedContent = msg.content.map(c => {
          if (c.type !== "text") return c;
          const text = c.text || "";
          
          const pointerMatch = text.match(/\[Results Archive: (ptr_[a-zA-Z0-9]+)\]/);
          if (pointerMatch) {
            const pointerId = pointerMatch[1];
            if (pointerId) {
              const archiveState = activeArchives.get(pointerId);
              if (archiveState?.invalidated) {
                return {
                  type: "text" as const,
                  text: `[Results Archive: ${pointerId} (Invalidated - Stale)]`
                };
              }
            }
          }
          return c;
        });

        return {
          ...msg,
          content: updatedContent
        };
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
        const archiveState = activeArchives.get(pointerId);

        if (!archiveState) {
          return {
            content: [{ type: "text", text: `Error: Pointer ${pointerId} not found in this branch.` }],
            isError: true,
            details: { status: "not_found" }
          } as any;
        }

        if (archiveState.invalidated) {
          return {
            content: [{ type: "text", text: `Warning: Pointer ${pointerId} was invalidated. Content is stale.` }],
            details: { originalContent: archiveState.entry.originalContent, status: "invalidated" }
          };
        }

        return {
          content: [{ type: "text", text: archiveState.entry.originalContent }],
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