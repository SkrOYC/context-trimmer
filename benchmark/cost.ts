import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ArchivedResult } from "../src/types";
import type { ModelPricing } from "./pricing";
import { pricePerToken } from "./pricing";
import type { TraceResult } from "./types";

export interface CostBreakdown {
  compressionRatio: number;
  kvInvalidationCost: number;
  recallCost: number;
  replacedCount: number;
  replacedTokens: number;
  totalTokens: number;
}

const APPROXIMATE_CHARS_PER_TOKEN = 4;

export function countTokens(text: string): number {
  return Math.ceil(text.length / APPROXIMATE_CHARS_PER_TOKEN);
}

export function messageText(message: AgentMessage): string {
  return message.content
    .map((content) => (content.type === "text" ? content.text || "" : ""))
    .join("\n");
}

export function computeTurnCost(
  originalMessages: AgentMessage[],
  compiledMessages: AgentMessage[],
  replacedPointerIds: Set<string>,
  archiveByToolCallId: Map<string, ArchivedResult>
): CostBreakdown {
  let totalTokens = 0;
  let replacedTokens = 0;
  let firstReplacementIndex = Number.POSITIVE_INFINITY;

  for (let i = 0; i < originalMessages.length; i += 1) {
    const original = originalMessages[i];
    const compiled = compiledMessages[i];
    if (!(original && compiled)) {
      continue;
    }

    const originalText = messageText(original);
    const compiledText = messageText(compiled);
    const originalTokens = countTokens(originalText);
    const compiledTokens = countTokens(compiledText);

    totalTokens += originalTokens;

    if (compiledText !== originalText) {
      const arc =
        original.role === "toolResult" && original.toolCallId
          ? archiveByToolCallId.get(original.toolCallId)
          : undefined;

      if (arc && replacedPointerIds.has(arc.pointerId)) {
        replacedTokens += Math.max(0, originalTokens - compiledTokens);
        firstReplacementIndex = Math.min(firstReplacementIndex, i);
      }
    }
  }

  // KV-cache invalidation cost: number of messages from the first replacement
  // to the end of the context. Replacing an older message invalidates more
  // messages ahead in the KV cache.
  const kvInvalidationCost =
    firstReplacementIndex === Number.POSITIVE_INFINITY
      ? 0
      : originalMessages.length - firstReplacementIndex;

  return {
    compressionRatio: totalTokens === 0 ? 0 : replacedTokens / totalTokens,
    kvInvalidationCost,
    recallCost: replacedPointerIds.size,
    replacedCount: replacedPointerIds.size,
    replacedTokens,
    totalTokens,
  };
}

export interface DollarCost {
  algorithm: string;
  baselineCost: number;
  netSavings: number;
  recallCost: number;
  trimmerCost: number;
}

const RECALL_INPUT_TOKENS = 50;

// Fraction of evicted archives the model actually recalls. The archive→pointer
// replacement is a safety net, not an expected access: eviction targets
// superseded content (a newer copy already exists) or stale content (the file
// changed), which the model almost never needs to reach back for. The earlier
// model charged one full-content recall per eviction — wildly pessimistic — and
// that single assumption was what made trimming look like a net loss. Callers
// pass the rate explicitly so the break-even is transparent, not baked in.
const DEFAULT_RECALL_RATE = 0.02;

export function computeTraceDollarCost(
  result: TraceResult,
  pricing: ModelPricing,
  recallRate: number = DEFAULT_RECALL_RATE
): DollarCost {
  const hasCaching = pricing.cacheReadPrice > 0;

  let lastBaselineTokens = 0;
  let baselineCost = 0;
  let trimmerContextCost = 0;

  for (const turn of result.turnResults) {
    // Baseline caching logic
    const baselineCacheRead = lastBaselineTokens;
    const baselineCacheWrite = Math.max(
      0,
      turn.baselineTokens - lastBaselineTokens
    );
    lastBaselineTokens = turn.baselineTokens;

    const baselineUseOver200k = turn.baselineTokens > 200_000;
    const baselineInputPrice = pricePerToken(
      baselineUseOver200k ? pricing.inputPriceOver200k : pricing.inputPrice
    );
    const baselineCacheReadPrice = pricePerToken(
      baselineUseOver200k
        ? pricing.cacheReadPriceOver200k
        : pricing.cacheReadPrice
    );
    const baselineCacheWritePrice = pricePerToken(
      baselineUseOver200k
        ? pricing.cacheWritePriceOver200k
        : pricing.cacheWritePrice
    );

    if (hasCaching) {
      baselineCost +=
        baselineCacheRead * baselineCacheReadPrice +
        baselineCacheWrite * baselineCacheWritePrice;
    } else {
      baselineCost += turn.baselineTokens * baselineInputPrice;
    }

    // Trimmer caching logic
    const trimmerUseOver200k = turn.compiledTokens > 200_000;
    const trimmerInputPrice = pricePerToken(
      trimmerUseOver200k ? pricing.inputPriceOver200k : pricing.inputPrice
    );
    const trimmerCacheReadPrice = pricePerToken(
      trimmerUseOver200k
        ? pricing.cacheReadPriceOver200k
        : pricing.cacheReadPrice
    );
    const trimmerCacheWritePrice = pricePerToken(
      trimmerUseOver200k
        ? pricing.cacheWritePriceOver200k
        : pricing.cacheWritePrice
    );

    if (hasCaching) {
      trimmerContextCost +=
        turn.cacheReadTokens * trimmerCacheReadPrice +
        turn.cacheWriteTokens * trimmerCacheWritePrice;
    } else {
      trimmerContextCost += turn.compiledTokens * trimmerInputPrice;
    }
  }

  // Estimate recall cost: one recall_result call per replaced archive.
  const lastTurn = result.turnResults.at(-1);
  const lastTurnUseOver200k = lastTurn
    ? lastTurn.compiledTokens > 200_000
    : false;
  const finalInputPrice = pricePerToken(
    lastTurnUseOver200k ? pricing.inputPriceOver200k : pricing.inputPrice
  );
  const finalOutputPrice = pricePerToken(
    lastTurnUseOver200k ? pricing.outputPriceOver200k : pricing.outputPrice
  );

  const avgRecalledTokens =
    result.replacedCount === 0
      ? 0
      : result.totalReplacedChars / 4 / result.replacedCount;

  const recallCost =
    result.replacedCount *
    recallRate *
    (RECALL_INPUT_TOKENS * finalInputPrice +
      avgRecalledTokens * finalOutputPrice);

  const trimmerCost = trimmerContextCost + recallCost;

  return {
    algorithm: "",
    baselineCost,
    netSavings: baselineCost - trimmerCost,
    recallCost,
    trimmerCost,
  };
}

export function aggregateCosts(results: CostBreakdown[]): CostBreakdown {
  const total = results.reduce(
    (acc, r) => ({
      compressionRatio: acc.compressionRatio + r.compressionRatio,
      kvInvalidationCost: acc.kvInvalidationCost + r.kvInvalidationCost,
      recallCost: acc.recallCost + r.recallCost,
      replacedCount: acc.replacedCount + r.replacedCount,
      replacedTokens: acc.replacedTokens + r.replacedTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
    }),
    {
      compressionRatio: 0,
      kvInvalidationCost: 0,
      recallCost: 0,
      replacedCount: 0,
      replacedTokens: 0,
      totalTokens: 0,
    }
  );

  const count = results.length || 1;
  return {
    compressionRatio: total.compressionRatio / count,
    kvInvalidationCost: total.kvInvalidationCost / count,
    recallCost: total.recallCost / count,
    replacedCount: total.replacedCount / count,
    replacedTokens: total.replacedTokens,
    totalTokens: total.totalTokens,
  };
}
