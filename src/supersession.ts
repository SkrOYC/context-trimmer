import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ArchivedResult, LineRange } from "./types";
import { mergeIntervals, totalIntervalLength } from "./utils";

/** Minimum threshold for the most recent reads (end of context). */
export const MIN_SUPERSESSION_THRESHOLD = 0.25;

/** Maximum threshold for the oldest reads (beginning of context). */
export const MAX_SUPERSESSION_THRESHOLD = 0.60;

/**
 * Compute the replacement threshold for a message based on its position in the
 * compiled context. Recent messages are cheap to remove (invalidate little KV
 * cache suffix), so they get a low threshold. Older messages are expensive to
 * remove, so they need a higher cumulative overlap to justify replacement.
 */
export function computeSupersessionThreshold(
  messageIndex: number,
  totalMessages: number
): number {
  if (totalMessages <= 1) return MIN_SUPERSESSION_THRESHOLD;

  // 0 = oldest, 1 = most recent
  const positionRatio = messageIndex / (totalMessages - 1);
  const recencyFactor = 1 - positionRatio; // 1 = recent, 0 = old

  return (
    MIN_SUPERSESSION_THRESHOLD +
    (MAX_SUPERSESSION_THRESHOLD - MIN_SUPERSESSION_THRESHOLD) * recencyFactor
  );
}

function getArchiveRange(arc: ArchivedResult): LineRange {
  return {
    start: arc.startLine,
    end: arc.startLine + arc.lineHashes.length - 1,
  };
}

function intersectRanges(a: LineRange, b: LineRange): LineRange | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  if (start > end) return null;
  return { start, end };
}

/**
 * Compute what fraction of `target` read's line range has been covered by any
 * of the `laterReads` (assumed to be newer reads of the same file).
 */
export function computeCoverage(
  target: ArchivedResult,
  laterReads: ArchivedResult[]
): number {
  if (target.lineHashes.length === 0) return 0;

  const targetRange = getArchiveRange(target);
  const overlaps: LineRange[] = [];

  for (const read of laterReads) {
    const readRange = getArchiveRange(read);
    const overlap = intersectRanges(targetRange, readRange);
    if (overlap) {
      overlaps.push(overlap);
    }
  }

  const merged = mergeIntervals(overlaps);
  const covered = totalIntervalLength(merged);
  return covered / target.lineHashes.length;
}

/**
 * Build a set of pointer IDs that should be replaced with pointers because
 * newer reads of the same file have cumulatively covered enough of their range.
 *
 * Only archives whose toolCallId appears in the current compiled messages are
 * considered. This ensures compacted or out-of-branch reads do not participate
 * in supersession decisions for the visible context.
 */
export function findSupersededArchives(
  messages: AgentMessage[],
  archivesByPath: Map<string, ArchivedResult[]>
): Set<string> {
  const superseded = new Set<string>();
  const indexByToolCallId = new Map<string, number>();

  messages.forEach((msg, idx) => {
    if (msg.role === "toolResult" && msg.toolCallId) {
      indexByToolCallId.set(msg.toolCallId, idx);
    }
  });

  for (const pathArchives of archivesByPath.values()) {
    // Only consider archives that are present in the current compiled messages.
    const indexed = pathArchives
      .map(arc => ({ arc, index: indexByToolCallId.get(arc.toolCallId) ?? -1 }))
      .filter(x => x.index >= 0)
      .sort((a, b) => a.index - b.index);

    for (let i = 0; i < indexed.length; i++) {
      const entry = indexed[i]!;
      const { arc: target, index: targetIndex } = entry;
      const laterReads = indexed.slice(i + 1).map(x => x.arc);
      const coverage = computeCoverage(target, laterReads);
      const threshold = computeSupersessionThreshold(targetIndex, messages.length);

      if (coverage >= threshold) {
        superseded.add(target.pointerId);
      }
    }
  }

  return superseded;
}
