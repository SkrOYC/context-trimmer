import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArchivedResult, EvictionCandidate } from "./types";

/**
 * Context-pressure eviction is intentionally deferred.
 *
 * This module provides the scaffolding for future eviction decisions. For now,
 * no archives are selected for pressure-based eviction.
 */

export interface EvictionContext {
  usagePercent: number | null;
  usageTokens: number | null;
  contextWindow: number | null;
}

export function getEvictionContext(ctx: ExtensionContext): EvictionContext {
  const usage = ctx.getContextUsage();
  return {
    usagePercent: usage?.percent ?? null,
    usageTokens: usage?.tokens ?? null,
    contextWindow: usage?.contextWindow ?? null,
  };
}

export function selectEvictionCandidates(
  _archives: ArchivedResult[],
  _ctx: EvictionContext
): EvictionCandidate[] {
  // Placeholder: no pressure-based eviction in this phase.
  return [];
}
