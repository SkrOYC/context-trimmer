import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ArchiveState } from "./state";
import { ARCHIVE_TYPE, type ArchivedResult, POLICIES } from "./types";
import { getHash } from "./utils";

export function createArchiveHandler(pi: ExtensionAPI, state: ArchiveState) {
  const { rebuildState, registerArchive } = state;

  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    const policy = POLICIES.find((p) => p.toolName === event.toolName);
    if (!policy) {
      return;
    }

    try {
      rebuildState(ctx);

      const contentStr = policy.extractContent(event);
      if (contentStr === undefined) {
        // No archivable content was returned (e.g. oversized line / empty result).
        return;
      }

      const paramKey = policy.getParameterKey(event.input);
      if (!paramKey) {
        return;
      }

      const offset = Number(event.input.offset) || 1;
      const lineHashes = contentStr.split("\n").map((line) => getHash(line));

      const pointerId = `ptr_${Math.random().toString(36).slice(2, 10)}`;
      const archiveRecord: ArchivedResult = {
        lineHashes,
        originalContent: JSON.stringify(event.content),
        parameterKey: paramKey,
        pointerId,
        stalenessStrategy: policy.stalenessStrategy,
        startLine: offset,
        supersessionStrategy: policy.supersessionStrategy,
        timestamp: Date.now(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };

      pi.appendEntry<ArchivedResult>(ARCHIVE_TYPE, archiveRecord);
      registerArchive(archiveRecord);
    } catch (err) {
      console.warn("[Context Trimmer] Failed to archive tool result:", err);
    }
  });
}
