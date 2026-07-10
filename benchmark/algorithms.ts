import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextUsage } from "../src/eviction";
import { selectEvictionCandidates } from "../src/eviction";
import type { ArchivedResult } from "../src/types";

export type CandidateSelector = (
  messages: AgentMessage[],
  archivesByPath: Map<string, ArchivedResult[]>,
  activeArchives: Map<string, ArchivedResult>,
  usage: ContextUsage,
  cwd: string
) => Set<string>;

export const noReplacement: CandidateSelector = () => new Set<string>();

export const currentAlgorithm: CandidateSelector = (
  messages,
  archivesByPath,
  activeArchives,
  usage,
  cwd
) =>
  selectEvictionCandidates(
    messages,
    archivesByPath,
    activeArchives,
    usage,
    cwd
  );

function buildToolCallIdIndex(
  activeArchives: Map<string, ArchivedResult>
): Map<string, ArchivedResult> {
  const archiveByToolCallId = new Map<string, ArchivedResult>();
  for (const arc of activeArchives.values()) {
    archiveByToolCallId.set(arc.toolCallId, arc);
  }
  return archiveByToolCallId;
}

function sumArchiveChars(
  messages: AgentMessage[],
  archiveByToolCallId: Map<string, ArchivedResult>
): number {
  let total = 0;
  for (const msg of messages) {
    if (msg.role !== "toolResult") {
      continue;
    }
    const arc = archiveByToolCallId.get(msg.toolCallId);
    if (arc) {
      total += arc.originalContent.length;
    }
  }
  return total;
}

export function oldestFirst(targetReductionRatio: number): CandidateSelector {
  return (
    messages: AgentMessage[],
    _archivesByPath: Map<string, ArchivedResult[]>,
    activeArchives: Map<string, ArchivedResult>,
    usage: ContextUsage,
    _cwd: string
  ): Set<string> => {
    if ((usage.percent ?? 0) < 70) {
      return new Set<string>();
    }

    const archiveByToolCallId = buildToolCallIdIndex(activeArchives);
    const totalArchiveChars = sumArchiveChars(messages, archiveByToolCallId);
    const targetChars = totalArchiveChars * targetReductionRatio;
    let removedChars = 0;
    const toReplace = new Set<string>();

    for (const msg of messages) {
      if (msg.role !== "toolResult") {
        continue;
      }
      const arc = archiveByToolCallId.get(msg.toolCallId);
      if (!arc) {
        continue;
      }

      toReplace.add(arc.pointerId);
      removedChars += arc.originalContent.length;

      if (removedChars >= targetChars) {
        break;
      }
    }

    return toReplace;
  };
}

export function supersessionOnly(): CandidateSelector {
  return (
    messages: AgentMessage[],
    archivesByPath: Map<string, ArchivedResult[]>,
    activeArchives: Map<string, ArchivedResult>,
    usage: ContextUsage,
    cwd: string
  ): Set<string> => {
    // Always run the current algorithm but with zero pressure contribution by
    // clamping the reported usage to just below the soft threshold. This lets
    // us measure how much replacement comes purely from staleness/supersession
    // signals.
    const dampedUsage: ContextUsage = {
      contextWindow: usage.contextWindow,
      percent: 70,
      tokens: usage.tokens,
    };
    return selectEvictionCandidates(
      messages,
      archivesByPath,
      activeArchives,
      dampedUsage,
      cwd
    );
  };
}

export const ALGORITHMS: Record<string, CandidateSelector> = {
  "current-70": currentAlgorithm,
  "no-replacement": noReplacement,
  "oldest-first-30": oldestFirst(0.3),
  "supersession-only": supersessionOnly(),
};
