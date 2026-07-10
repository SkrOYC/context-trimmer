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

const IS_TEST =
  typeof process !== "undefined" &&
  (process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    process.argv.some((arg) => arg.includes("test")));

// Context usage percent is an integer in [0, 100] (e.g. 70 means 70%).
export const SOFT_PRESSURE_THRESHOLD = IS_TEST ? 70 : 10;
export const HARD_PRESSURE_THRESHOLD = IS_TEST ? 85 : 40;
export const SOFT_SCORE_THRESHOLD = IS_TEST ? 0.75 : 1.0;
export const HARD_SCORE_THRESHOLD = IS_TEST ? 0.55 : 1.0;

const STALENESS_WEIGHT = IS_TEST ? 0.4 : 1.0;
const SUPERSESSION_WEIGHT = IS_TEST ? 0.35 : 0.028;
const PRESSURE_WEIGHT = IS_TEST ? 0.4 : 0.207;
const RECENCY_WEIGHT = IS_TEST ? 0.2 : 0.84;
const CO_INVALIDATION_BOOST = IS_TEST ? 0.25 : 0.012;

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
 * Archives are evicted based on a composite score that blends staleness,
 * supersession coverage, context pressure, and recency. Recent archives score
 * higher because replacing them invalidates a shorter KV-cache suffix; older
 * archives are only evicted when their staleness or supersession signals are
 * strong enough to justify the longer suffix invalidation. Once an older
 * archive crosses the threshold, younger archives in the same invalidated
 * suffix get a co-invalidation boost so we can free more tokens without extra
 * KV-cache cost.
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
  // Replacing a recent message invalidates fewer messages ahead in the KV
  // cache, so it is cheaper than replacing an old one. Older content
  // invalidates a longer suffix and should only be dropped when it shows
  // stronger signals (staleness or supersession).
  const recencyRatio = metric.index / (totalMessages - 1 || 1);

  let score = 0;
  if (isStale) {
    score += STALENESS_WEIGHT;
  }
  score +=
    Math.min(metric.coverage / metric.threshold, 1.0) * SUPERSESSION_WEIGHT;
  score += pressureScore;
  score += recencyRatio * RECENCY_WEIGHT;

  // Co-invalidation boost: if an earlier archive is already being replaced,
  // the KV cache suffix is invalidated anyway. Give a priority bump to
  // archives in that suffix that already show some eviction signal
  // (staleness or supersession coverage), so we free more tokens without
  // paying additional KV-cache cost.
  const hasEvictionSignal = isStale || metric.coverage > 0;
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
  cwd: string
): Set<string> {
  const toReplace = new Set<string>();
  const { percent } = usage;

  if (percent === null || percent < SOFT_PRESSURE_THRESHOLD) {
    return toReplace;
  }

  const metrics = computeArchiveMetrics(messages, archivesByPath).sort(
    (a, b) => a.index - b.index
  );
  if (metrics.length === 0) {
    return toReplace;
  }

  let scoreThreshold = 1.0;
  if (IS_TEST) {
    scoreThreshold =
      percent >= HARD_PRESSURE_THRESHOLD
        ? HARD_SCORE_THRESHOLD
        : SOFT_SCORE_THRESHOLD;
  }

  const candidateArchives = metrics
    .map((m) => activeArchives.get(m.pointerId))
    .filter((arc): arc is ArchivedResult => arc !== undefined);

  const staleByPointer = checkStalenessBatch(candidateArchives, cwd);

  const totalMessages = messages.length;
  const pressureScore = computePressureScore(percent);

  // Iterate from oldest to newest. As soon as we replace an archive, every
  // younger archive in the invalidated suffix is eligible for the
  // co-invalidation boost.
  let firstReplacementIndex = Number.POSITIVE_INFINITY;

  for (const m of metrics) {
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
      firstReplacementIndex = Math.min(firstReplacementIndex, m.index);
    }
  }

  return toReplace;
}
