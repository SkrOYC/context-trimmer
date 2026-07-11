import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextUsage, EvictionConfig } from "../src/eviction";
import { selectEvictionCandidates } from "../src/eviction";
import type { ArchivedResult } from "../src/types";

export type CandidateSelector = (
  messages: AgentMessage[],
  archivesByPath: Map<string, ArchivedResult[]>,
  activeArchives: Map<string, ArchivedResult>,
  usage: ContextUsage,
  cwd: string,
  alreadyEvicted: ReadonlySet<string>,
  stalenessOverride?: ReadonlyMap<string, boolean>
) => Set<string>;

export const noReplacement: CandidateSelector = () => new Set<string>();

/**
 * Bind a specific EvictionConfig to the shipped eviction algorithm, so the
 * optimizer can compare configs against the exact production code path.
 */
export function makeProduction(config: EvictionConfig): CandidateSelector {
  return (
    messages,
    archivesByPath,
    activeArchives,
    usage,
    cwd,
    alreadyEvicted,
    stalenessOverride
  ) =>
    selectEvictionCandidates(
      messages,
      archivesByPath,
      activeArchives,
      usage,
      cwd,
      alreadyEvicted,
      config,
      stalenessOverride
    );
}

export const currentAlgorithm: CandidateSelector = (
  messages,
  archivesByPath,
  activeArchives,
  usage,
  cwd,
  alreadyEvicted,
  stalenessOverride
) =>
  selectEvictionCandidates(
    messages,
    archivesByPath,
    activeArchives,
    usage,
    cwd,
    alreadyEvicted,
    undefined,
    stalenessOverride
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

import { computeArchiveMetrics } from "../src/supersession";
import { checkStalenessBatch } from "../src/utils";
import { messageText } from "./cost";

interface DecisionConfig {
  maxTurns: number;
  pRecallActive: number;
  pRecallPartial: number;
  pRecallStale: number;
}

interface DecisionContext {
  config?: DecisionConfig;
  estimatedRemainingTurns: number;
  messageSizes: number[];
  staleByPointer: Map<string, boolean>;
  totalMessages: number;
}

function shouldEvict(
  m: { index: number; pointerId: string; coverage: number; threshold: number },
  ctx: DecisionContext,
  messages: AgentMessage[]
): boolean {
  const isStale = ctx.staleByPointer.get(m.pointerId) ?? false;
  const msg = messages[m.index];
  if (!msg) {
    return false;
  }
  const S = Math.ceil(messageText(msg).length / 4);

  // Calculate trailing suffix size R
  let R = 0;
  for (let idx = m.index + 1; idx < ctx.totalMessages; idx += 1) {
    const size = ctx.messageSizes[idx];
    if (size !== undefined) {
      R += size;
    }
  }

  // Determine P_recall based on config
  const config = ctx.config ?? {
    maxTurns: 40,
    pRecallActive: 0.3,
    pRecallPartial: 0.15,
    pRecallStale: 0.05,
  };

  let P_recall = config.pRecallActive;
  if (m.coverage >= m.threshold) {
    P_recall = 0.0; // Fully superseded
  } else if (isStale) {
    P_recall = config.pRecallStale;
  } else if (m.coverage > 0) {
    P_recall = config.pRecallPartial;
  }

  // Estimates for Claude 4.5 Opus cache rates
  const cacheReadPrice = 0.1;
  const cacheWritePrice = 1.25;
  const outputPrice = 5.0;

  // Cost of recall
  const recallCost = 50 * 1.0 + S * outputPrice;

  // Delta cost: savings vs penalties
  const savings = S * cacheReadPrice * ctx.estimatedRemainingTurns;
  const invalidationPenalty = R * (cacheWritePrice - cacheReadPrice);
  const expectedRecall = P_recall * recallCost;

  const deltaCost = -savings + invalidationPenalty + expectedRecall;
  return deltaCost < 0;
}

export const optimizedCacheAware: CandidateSelector = (
  messages: AgentMessage[],
  archivesByPath: Map<string, ArchivedResult[]>,
  activeArchives: Map<string, ArchivedResult>,
  usage: ContextUsage,
  cwd: string
): Set<string> => {
  const toReplace = new Set<string>();
  const percent = usage.percent ?? 0;

  // We only trim if we are under context pressure (e.g. usage > 40%)
  if (percent < 40) {
    return toReplace;
  }

  const metrics = computeArchiveMetrics(messages, archivesByPath).sort(
    (a, b) => a.index - b.index
  );
  if (metrics.length === 0) {
    return toReplace;
  }

  const candidateArchives = metrics
    .map((m) => activeArchives.get(m.pointerId))
    .filter((arc): arc is ArchivedResult => arc !== undefined);

  const staleByPointer = checkStalenessBatch(candidateArchives, cwd);
  const totalMessages = messages.length;

  // Approximate remaining turns: assume target is 40 turns total
  const estimatedRemainingTurns = Math.max(1, 40 - totalMessages);

  // Compile message sizes to calculate trailing suffix size (R)
  const messageSizes = messages.map((msg) =>
    Math.ceil(messageText(msg).length / 4)
  );

  const ctx: DecisionContext = {
    estimatedRemainingTurns,
    messageSizes,
    staleByPointer,
    totalMessages,
  };

  for (const m of metrics) {
    const arc = activeArchives.get(m.pointerId);
    if (arc && shouldEvict(m, ctx, messages)) {
      toReplace.add(m.pointerId);
    }
  }

  return toReplace;
};

export function makeOptimizedCacheAware(
  config: DecisionConfig
): CandidateSelector {
  return (
    messages: AgentMessage[],
    archivesByPath: Map<string, ArchivedResult[]>,
    activeArchives: Map<string, ArchivedResult>,
    usage: ContextUsage,
    cwd: string
  ): Set<string> => {
    const toReplace = new Set<string>();
    const percent = usage.percent ?? 0;

    if (percent < 40) {
      return toReplace;
    }

    const metrics = computeArchiveMetrics(messages, archivesByPath).sort(
      (a, b) => a.index - b.index
    );
    if (metrics.length === 0) {
      return toReplace;
    }

    const candidateArchives = metrics
      .map((m) => activeArchives.get(m.pointerId))
      .filter((arc): arc is ArchivedResult => arc !== undefined);

    const staleByPointer = checkStalenessBatch(candidateArchives, cwd);
    const totalMessages = messages.length;
    const estimatedRemainingTurns = Math.max(
      1,
      config.maxTurns - totalMessages
    );

    const messageSizes = messages.map((msg) =>
      Math.ceil(messageText(msg).length / 4)
    );

    const ctx: DecisionContext = {
      config,
      estimatedRemainingTurns,
      messageSizes,
      staleByPointer,
      totalMessages,
    };

    for (const m of metrics) {
      const arc = activeArchives.get(m.pointerId);
      if (arc && shouldEvict(m, ctx, messages)) {
        toReplace.add(m.pointerId);
      }
    }

    return toReplace;
  };
}

export const ALGORITHMS: Record<string, CandidateSelector> = {
  // Baselines.
  "no-replacement": noReplacement,
  "oldest-first-30": oldestFirst(0.3),
  // The marginal-cost model: evict when the sustained cache-read savings beat the
  // one-time suffix invalidation plus expected recall. Kept as a comparison.
  "optimized-cache-aware": optimizedCacheAware,
  // The shipped production policy (src/eviction.ts) — the exact code path a live
  // agent runs, exercised here without any benchmark-only reparameterization.
  production: currentAlgorithm,
};
