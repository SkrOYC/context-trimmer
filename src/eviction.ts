import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeArchiveMetrics } from "./supersession";
import type { ArchivedResult } from "./types";
import { checkStalenessBatch } from "./utils";

export interface ContextUsage {
  contextWindow: number | null;
  percent: number | null;
  tokens: number | null;
}

// Context usage percent is an integer in [0, 100] (e.g. 70 means 70%).
export const SOFT_PRESSURE_THRESHOLD = 70;
export const HARD_PRESSURE_THRESHOLD = 85;
export const SOFT_SCORE_THRESHOLD = 0.75;
export const HARD_SCORE_THRESHOLD = 0.55;
export const CO_INVALIDATION_BOOST = 0.25;

const STALENESS_WEIGHT = 0.4;
const SUPERSESSION_WEIGHT = 0.35;
const PRESSURE_WEIGHT = 0.4;
const AGE_WEIGHT = 0.2;

export function getEvictionContext(ctx: ExtensionContext): ContextUsage {
  const usage = ctx.getContextUsage();
  return {
    contextWindow: usage?.contextWindow ?? null,
    percent: usage?.percent ?? null,
    tokens: usage?.tokens ?? null,
  };
}

function computePressureScore(percent: number): number {
  if (percent <= SOFT_PRESSURE_THRESHOLD) {
    return 0;
  }
  const range = 100 - SOFT_PRESSURE_THRESHOLD;
  const progress = Math.min((percent - SOFT_PRESSURE_THRESHOLD) / range, 1);
  return progress * PRESSURE_WEIGHT;
}

/**
 * Select archives that should be replaced in context.
 *
 * Starts with already-superseded archives. If context usage is above the soft
 * pressure threshold, additional archives are evicted based on a composite
 * score. Archives located after the earliest replacement get a co-invalidation
 * boost: replacing them is essentially free KV-cache-wise because the suffix
 * was already invalidated by the earlier replacement.
 */
interface EvictionScoreInput {
  firstReplacementIndex: number;
  isStale: boolean;
  metric: ReturnType<typeof computeArchiveMetrics>[number];
  pressureScore: number;
  totalMessages: number;
}

function computeEvictionScore({
  metric,
  isStale,
  totalMessages,
  pressureScore,
  firstReplacementIndex,
}: EvictionScoreInput): number {
  const ageRatio = 1 - metric.index / (totalMessages - 1 || 1);

  let score = 0;
  if (isStale) {
    score += STALENESS_WEIGHT;
  }
  score +=
    Math.min(metric.coverage / metric.threshold, 1.0) * SUPERSESSION_WEIGHT;
  score += pressureScore;
  score += ageRatio * AGE_WEIGHT;

  // Co-invalidation boost: if an earlier message is already being replaced,
  // the KV cache suffix is invalidated anyway. Give a priority bump to newer
  // archives that already show some eviction signal (coverage, staleness, or
  // age), but don't boost completely fresh recent reads that have no reason
  // to be evicted.
  const hasEvictionSignal = isStale || metric.coverage > 0 || ageRatio >= 0.5;
  if (metric.index >= firstReplacementIndex && hasEvictionSignal) {
    score += CO_INVALIDATION_BOOST;
  }

  return score;
}

export function selectEvictionCandidates(
  messages: AgentMessage[],
  archivesByPath: Map<string, ArchivedResult[]>,
  activeArchives: Map<string, ArchivedResult>,
  usage: ContextUsage,
  superseded: Set<string>,
  cwd: string
): Set<string> {
  const toReplace = new Set(superseded);
  const { percent } = usage;

  if (percent === null || percent < SOFT_PRESSURE_THRESHOLD) {
    return toReplace;
  }

  const metrics = computeArchiveMetrics(messages, archivesByPath);
  if (metrics.length === 0) {
    return toReplace;
  }

  // Find the earliest message index that is already being replaced. Replacing
  // that message invalidates the KV cache for everything after it, so newer
  // candidates in that suffix can be evicted more aggressively.
  let firstReplacementIndex = Number.POSITIVE_INFINITY;
  for (const m of metrics) {
    if (toReplace.has(m.pointerId)) {
      firstReplacementIndex = Math.min(firstReplacementIndex, m.index);
    }
  }

  const scoreThreshold =
    percent >= HARD_PRESSURE_THRESHOLD
      ? HARD_SCORE_THRESHOLD
      : SOFT_SCORE_THRESHOLD;

  const candidateArchives = metrics
    .map((m) => activeArchives.get(m.pointerId))
    .filter((arc): arc is ArchivedResult => arc !== undefined);

  const staleByPointer = checkStalenessBatch(candidateArchives, cwd);

  const totalMessages = messages.length;
  const pressureScore = computePressureScore(percent);

  for (const m of metrics) {
    if (toReplace.has(m.pointerId)) {
      continue;
    }

    const arc = activeArchives.get(m.pointerId);
    if (!arc) {
      continue;
    }

    const isStale = staleByPointer.get(m.pointerId) ?? false;
    const score = computeEvictionScore({
      firstReplacementIndex,
      isStale,
      metric: m,
      pressureScore,
      totalMessages,
    });

    if (score >= scoreThreshold) {
      toReplace.add(m.pointerId);
    }
  }

  return toReplace;
}
