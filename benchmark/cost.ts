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

export function computeTraceDollarCost(
  result: TraceResult,
  pricing: ModelPricing
): DollarCost {
  const inputPrice = pricePerToken(pricing.inputPrice);
  const outputPrice = pricePerToken(pricing.outputPrice);

  const baselineCost = result.turnResults.reduce(
    (sum, turn) => sum + turn.baselineTokens * inputPrice,
    0
  );

  const trimmerContextCost = result.turnResults.reduce(
    (sum, turn) => sum + turn.compiledTokens * inputPrice,
    0
  );

  // Estimate recall cost: one recall_result call per replaced archive. The
  // call itself consumes input tokens; the returned original content consumes
  // output tokens. We approximate the returned content size by the average
  // replaced chunk size.
  const avgRecalledTokens =
    result.replacedCount === 0
      ? 0
      : result.totalReplacedChars / 4 / result.replacedCount;

  const recallCost =
    result.replacedCount *
    (RECALL_INPUT_TOKENS * inputPrice + avgRecalledTokens * outputPrice);

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
