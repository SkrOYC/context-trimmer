import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { ArchiveState } from "./state";
import {
  ARCHIVE_TYPE,
  type ArchivedResult,
  POLICIES,
  type ToolPolicy,
} from "./types";
import { getHash } from "./utils";

/**
 * Build the archive payload for a tool result. Returns undefined when the result
 * has no archivable content or no resolvable parameter. Shared by the live
 * tool_result handler and the retroactive backfill.
 */
export function buildArchiveRecord(
  policy: ToolPolicy,
  event: ToolResultEvent
): ArchivedResult | undefined {
  const contentStr = policy.extractContent(event);
  if (contentStr === undefined) {
    return;
  }

  const paramKey = policy.getParameterKey(event.input);
  if (!paramKey) {
    return;
  }

  const offset = Number(event.input.offset) || 1;
  const lineHashes = contentStr.split("\n").map((line) => getHash(line));

  return {
    lineHashes,
    originalContent: JSON.stringify(event.content),
    parameterKey: paramKey,
    pointerId: `ptr_${Math.random().toString(36).slice(2, 10)}`,
    stalenessStrategy: policy.stalenessStrategy,
    startLine: offset,
    supersessionStrategy: policy.supersessionStrategy,
    timestamp: Date.now(),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  };
}

export function createArchiveHandler(pi: ExtensionAPI, state: ArchiveState) {
  const { rebuildState, registerArchive } = state;

  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    const policy = POLICIES.find((p) => p.toolName === event.toolName);
    if (!policy) {
      return;
    }

    // Failed tool calls (a read of a directory -> EISDIR, a missing file ->
    // ENOENT, a bash command exiting non-zero, ...) carry an error string, not
    // recallable content. Archiving them line-hashes the error text and, for
    // reads, records the offending path as a file-backed archive whose later
    // staleness check tries to read a directory. Skip them entirely.
    if (event.isError) {
      return;
    }

    try {
      rebuildState(ctx);

      const archiveRecord = buildArchiveRecord(policy, event);
      if (!archiveRecord) {
        // No archivable content was returned (e.g. oversized line / empty result).
        return;
      }

      pi.appendEntry<ArchivedResult>(ARCHIVE_TYPE, archiveRecord);
      registerArchive(archiveRecord);
    } catch (err) {
      console.warn("[Context Trimmer] Failed to archive tool result:", err);
    }
  });
}
