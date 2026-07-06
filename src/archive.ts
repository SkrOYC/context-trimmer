import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isReadToolResult } from "@earendil-works/pi-coding-agent";
import type { ArchiveState } from "./state";
import { ARCHIVE_TYPE, type ArchivedResult, POLICIES } from "./types";
import { getHash, stripReadFooters } from "./utils";

export function createArchiveHandler(pi: ExtensionAPI, state: ArchiveState) {
  const { rebuildState, registerArchive } = state;

  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    const policy = POLICIES.find((p) => p.toolName === event.toolName);
    if (!policy) {
      return;
    }

    if (!isReadToolResult(event)) {
      return;
    }

    const rawText = event.content
      .map((c) => (c.type === "text" ? c.text || "" : ""))
      .join("\n");

    try {
      rebuildState(ctx);

      // Determine the actual file content returned by the read tool, excluding
      // any continuation/truncation footers it appends. Prefer the structured
      // truncation metadata when available, otherwise strip known footer patterns.
      const truncation = event.details?.truncation;
      let contentStr: string;
      if (truncation) {
        if (truncation.firstLineExceedsLimit) {
          // No actual file content was returned; nothing to archive.
          return;
        }
        contentStr = truncation.content;
      } else {
        contentStr = stripReadFooters(rawText);
      }

      const paramKey = policy.getParameterKey(event.input) || "default";
      const offset = Number(event.input.offset) || 1;
      const lineHashes = contentStr.split("\n").map((line) => getHash(line));

      const pointerId = `ptr_${Math.random().toString(36).slice(2, 10)}`;
      const archiveRecord: ArchivedResult = {
        lineHashes,
        originalContent: JSON.stringify(event.content),
        parameterKey: paramKey,
        pointerId,
        startLine: offset,
        timestamp: Date.now(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };

      pi.appendEntry<ArchivedResult>(ARCHIVE_TYPE, archiveRecord);
      registerArchive(archiveRecord);
    } catch (err) {
      console.warn("[Context Trimmer] Failed to archive read result:", err);
    }
  });
}
