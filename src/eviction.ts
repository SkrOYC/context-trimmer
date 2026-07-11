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

// --- Weighted, normalized eviction scoring --------------------------------
//
// Goal: keep the working context as SMALL as possible (large contexts push the
// model into a quality "dumb zone", so lower is strictly better), bounded by two
// forces that pull the other way:
//
//   1. KV-cache cost. The agent re-sends the whole context every turn, so a
//      stable prefix is served from cache (~10x cheaper). Replacing a message
//      with a pointer edits the middle of the context and invalidates the cache
//      from that point on. So trimming is never free, and trimming a little
//      every turn (thrashing) is the worst case.
//   2. Recall risk. Evicted content is restorable via a pointer, but reaching
//      for it costs a round-trip, so we should prefer dropping content that is
//      genuinely dead (proven stale / superseded) over merely-old-but-valid.
//
// Every archived tool result gets a single score in [0, 1], a weighted sum of
// normalized signals. Each signal maps its raw evidence to [0, 1]; each has a
// SHARE of the total (the weights sum to 1), so a 30%-weighted signal at 1.0
// outweighs a 20%-weighted signal at 1.0. A message is eligible for eviction
// once its score crosses the threshold. Signals pull against each other on
// purpose (coldness says "drop the old one", affordability says "the old one is
// expensive to drop") -- the whole point is to find the weight combination that
// balances them, which is what benchmark/optimize.ts searches for.
export interface EvictionWeights {
  affordability: number;
  coldness: number;
  pressure: number;
  semantic: number;
  size: number;
  staleness: number;
  supersession: number;
}

export interface EvictionConfig {
  // Confidence that an "immutable" tool result (bash/grep/find/ls) is stale. We
  // can PROVE a read is stale by re-hashing the file; for immutable tools we can
  // only assume it, so the staleness signal is discounted by this factor.
  immutableStalenessConfidence: number;
  // Batching: only fire an eviction event once the eligible archives would free
  // at least this many tokens. This is what keeps eviction to a few large,
  // amortized KV-cache invalidations instead of one edit every turn.
  minBatchTokens: number;
  // If the compiled context reaches this fraction of the window, force an
  // eviction event even if the batch is small -- overflow must be avoided.
  overflowGuardFraction: number;
  // Pressure ramps in above these knees (a fraction of the window, and an
  // absolute token count); the higher of the two ramps wins.
  pressureAbsoluteKnee: number;
  pressurePercentKnee: number;
  // Per-tool disposability (higher = safer/cheaper to evict). Learned.
  semanticByTool: Record<string, number>;
  // Eviction bar: a message is eligible once its weighted score >= threshold.
  threshold: number;
  weights: EvictionWeights;
}

// The aggressiveness knobs (threshold, pressure knees, minBatchTokens) are set
// by PRINCIPLE, not fit to the benchmark. Replaying traces that were generated
// without trimming cannot reveal the cost of over-trimming (the re-reads our
// trimming would force never happened in the source run), so a pure
// minimize-context optimizer collapses the context to near-empty. We therefore
// pick a conservative cap for still-valid content and let provably-dead content
// evict freely. The weight SHARES and per-tool semantics below CAN be learned
// honestly from the benchmark (see benchmark/optimize.ts) and were tuned there.
export const DEFAULT_EVICTION_CONFIG: EvictionConfig = {
  // bash/grep/find/ls staleness is only assumed, never proven, so discount it.
  immutableStalenessConfidence: 0.4,
  // Batch ~4% of a 200k window before firing: keeps eviction to a few large,
  // amortized KV-cache invalidations instead of a trickle of small ones.
  minBatchTokens: 8000,
  overflowGuardFraction: 0.9,
  // Valid content only starts feeling pressure past ~60% / 130k tokens.
  pressureAbsoluteKnee: 130_000,
  pressurePercentKnee: 0.6,
  // Reads are the most valuable to keep (real file content); directory/command
  // output is cheaper to drop. Learned, seeded from this ordering.
  semanticByTool: { bash: 0.55, find: 0.5, grep: 0.5, ls: 0.6, read: 0.3 },
  // A conservative bar: still-valid content needs a strong combined signal
  // (mostly pressure) before it is trimmed. Dead content bypasses this entirely.
  threshold: 0.6,
  weights: {
    affordability: 0.1,
    coldness: 0.15,
    pressure: 0.3,
    semantic: 0.15,
    size: 0.15,
    staleness: 0.075,
    supersession: 0.075,
  },
};

const APPROX_CHARS_PER_TOKEN = 4;
const DEFAULT_SEMANTIC = 0.5;

export function getEvictionContext(ctx: ExtensionContext): ContextUsage {
  const usage = ctx.getContextUsage();
  return {
    contextWindow: usage?.contextWindow ?? null,
    percent: usage?.percent ?? null,
    tokens: usage?.tokens ?? null,
  };
}

function messageTokens(message: AgentMessage): number {
  const text = message.content
    .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("\n");
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

const POINTER_TOKENS = Math.ceil(
  "[Results Archive: ptr_xxxxxxxx (Invalidated - Stale)]".length /
    APPROX_CHARS_PER_TOKEN
);

function clamp01(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function ramp(value: number, knee: number, ceiling: number): number {
  if (ceiling <= knee) {
    return value >= ceiling ? 1 : 0;
  }
  return clamp01((value - knee) / (ceiling - knee));
}

export interface EvictionSignals {
  affordability: number;
  coldness: number;
  pressure: number;
  semantic: number;
  size: number;
  staleness: number;
  supersession: number;
}

export function scoreFromSignals(
  signals: EvictionSignals,
  weights: EvictionWeights
): number {
  return (
    weights.affordability * signals.affordability +
    weights.coldness * signals.coldness +
    weights.pressure * signals.pressure +
    weights.semantic * signals.semantic +
    weights.size * signals.size +
    weights.staleness * signals.staleness +
    weights.supersession * signals.supersession
  );
}

interface Candidate {
  index: number;
  pointerId: string;
  provenDead: boolean;
  savedTokens: number;
  signals: EvictionSignals;
  tokens: number;
}

interface CandidateContext {
  activeArchives: Map<string, ArchivedResult>;
  ageSpan: number;
  compiledTokens: number;
  config: EvictionConfig;
  maxCandidateTokens: number;
  mostRecentIndex: number;
  pressure: number;
  staleByPointer: ReadonlyMap<string, boolean>;
  tokensByIndex: number[];
}

// Provably-dead content evicts freely, independent of pressure: a fully
// superseded archive or a proven-stale read is both wrong-to-keep and dumb-zone
// ballast. Still-valid content is only trimmed once there is genuine pressure
// (compiled context above the pressure knee, so pressure > 0) AND its weighted
// score clears the threshold -- the cap that stops the discretionary weights
// from throwing away good content early. The co-location pass then re-scores the
// suffix after the oldest removal with affordability = 1 (that suffix is a cache
// miss anyway) and collects everyone still eligible.
function collectEligible(
  candidates: Candidate[],
  pressure: number,
  config: EvictionConfig
): Candidate[] {
  const underPressure = pressure > 0;
  const isEligible = (c: Candidate, signals: EvictionSignals): boolean =>
    c.provenDead ||
    (underPressure &&
      scoreFromSignals(signals, config.weights) >= config.threshold);

  const firstRemovalIndex = candidates
    .filter((c) => isEligible(c, c.signals))
    .reduce((min, c) => Math.min(min, c.index), Number.POSITIVE_INFINITY);

  const eligible: Candidate[] = [];
  for (const c of candidates) {
    const signals =
      c.index > firstRemovalIndex
        ? { ...c.signals, affordability: 1 }
        : c.signals;
    if (isEligible(c, signals)) {
      eligible.push(c);
    }
  }
  return eligible;
}

function buildCandidate(
  m: ReturnType<typeof computeArchiveMetrics>[number],
  ctx: CandidateContext
): Candidate {
  const arc = ctx.activeArchives.get(m.pointerId);
  const tokens = ctx.tokensByIndex[m.index] ?? 0;

  const supersession = m.threshold > 0 ? clamp01(m.coverage / m.threshold) : 0;

  const proven = arc?.stalenessStrategy !== "immutable";
  const rawStale = ctx.staleByPointer.get(m.pointerId) ?? false;
  const provenStaleness = proven ? 1 : ctx.config.immutableStalenessConfidence;
  const staleness = rawStale ? provenStaleness : 0;

  const coldness = (ctx.mostRecentIndex - m.index) / ctx.ageSpan;
  const size = tokens / ctx.maxCandidateTokens;

  // Suffix tokens after this message; a shorter suffix = cheaper to invalidate
  // = more affordable to evict.
  let suffixTokens = 0;
  for (let i = m.index + 1; i < ctx.tokensByIndex.length; i += 1) {
    suffixTokens += ctx.tokensByIndex[i] ?? 0;
  }
  const affordability =
    ctx.compiledTokens > 0 ? clamp01(1 - suffixTokens / ctx.compiledTokens) : 1;

  const semantic = arc
    ? (ctx.config.semanticByTool[arc.toolName] ?? DEFAULT_SEMANTIC)
    : DEFAULT_SEMANTIC;

  // Proven-dead = a newer copy of the exact content exists (full supersession),
  // or a READ whose file has provably changed on disk. Assumed staleness on
  // immutable tools does NOT count as proven, so it can never bypass the cap.
  const provenDead = supersession >= 1 || (proven && rawStale);

  return {
    index: m.index,
    pointerId: m.pointerId,
    provenDead,
    savedTokens: Math.max(0, tokens - POINTER_TOKENS),
    signals: {
      affordability,
      coldness,
      pressure: ctx.pressure,
      semantic,
      size,
      staleness,
      supersession,
    },
    tokens,
  };
}

/**
 * Select the full set of archive pointers to replace this turn.
 *
 * Eviction is append-only: the returned set is always a superset of
 * `alreadyEvicted` (un-replacing a pointer would re-invalidate a KV-cache suffix
 * we already paid to rewrite). Each candidate is scored; the eligible ones
 * (score >= threshold) are removed as one batched event, but only once the batch
 * is large enough (or the overflow guard trips) so we don't break the cache
 * every turn. The single most recently archived result is always protected.
 */
export function selectEvictionCandidates(
  messages: AgentMessage[],
  archivesByPath: Map<string, ArchivedResult[]>,
  activeArchives: Map<string, ArchivedResult>,
  usage: ContextUsage,
  cwd: string,
  alreadyEvicted: ReadonlySet<string> = new Set(),
  config: EvictionConfig = DEFAULT_EVICTION_CONFIG,
  // Optional precomputed staleness (pointerId -> isStale). Production leaves this
  // undefined and staleness is checked against disk; the benchmark passes a
  // staleness map synthesized from the trace's own later writes.
  stalenessOverride?: ReadonlyMap<string, boolean>
): Set<string> {
  const evicted = new Set<string>(alreadyEvicted);

  const window = usage.contextWindow;
  if (window === null || window <= 0) {
    return evicted;
  }

  const metrics = computeArchiveMetrics(messages, archivesByPath).sort(
    (a, b) => a.index - b.index
  );
  if (metrics.length === 0) {
    return evicted;
  }

  const tokensByIndex = messages.map(messageTokens);

  // Compiled size counts already-evicted archives as their pointer stub.
  const evictedIndices = new Set<number>();
  for (const m of metrics) {
    if (evicted.has(m.pointerId)) {
      evictedIndices.add(m.index);
    }
  }
  let compiledTokens = 0;
  for (let i = 0; i < tokensByIndex.length; i += 1) {
    compiledTokens += evictedIndices.has(i)
      ? POINTER_TOKENS
      : (tokensByIndex[i] ?? 0);
  }

  // Pressure is shared by every candidate this turn: the higher of the percent
  // ramp and the absolute-token ramp.
  const pressure = Math.max(
    ramp(compiledTokens / window, config.pressurePercentKnee, 1),
    ramp(compiledTokens, config.pressureAbsoluteKnee, window)
  );

  const mostRecentIndex = metrics.reduce(
    (max, m) => Math.max(max, m.index),
    -1
  );

  const candidateMetrics = metrics.filter(
    (m) => !evicted.has(m.pointerId) && m.index !== mostRecentIndex
  );
  if (candidateMetrics.length === 0) {
    return evicted;
  }

  const candidateArchives = candidateMetrics
    .map((m) => activeArchives.get(m.pointerId))
    .filter((arc): arc is ArchivedResult => arc !== undefined);
  const staleByPointer =
    stalenessOverride ?? checkStalenessBatch(candidateArchives, cwd);

  const oldestIndex = candidateMetrics.reduce(
    (min, m) => Math.min(min, m.index),
    Number.POSITIVE_INFINITY
  );
  const ageSpan = Math.max(1, mostRecentIndex - oldestIndex);
  const maxCandidateTokens = candidateMetrics.reduce(
    (max, m) => Math.max(max, tokensByIndex[m.index] ?? 0),
    1
  );

  const candidates: Candidate[] = candidateMetrics.map((m) =>
    buildCandidate(m, {
      activeArchives,
      ageSpan,
      compiledTokens,
      config,
      maxCandidateTokens,
      mostRecentIndex,
      pressure,
      staleByPointer,
      tokensByIndex,
    })
  );

  const eligible = collectEligible(candidates, pressure, config);
  if (eligible.length === 0) {
    return evicted;
  }

  const freeTokens = eligible.reduce((sum, c) => sum + c.savedTokens, 0);
  const mustEvict = compiledTokens >= window * config.overflowGuardFraction;

  // Batch: hold small removals until enough mass accumulates, unless we are up
  // against the window.
  if (freeTokens < config.minBatchTokens && !mustEvict) {
    return evicted;
  }

  for (const c of eligible) {
    evicted.add(c.pointerId);
  }
  return evicted;
}
