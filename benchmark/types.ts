import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface ParsedTurn {
  observation: string;
  toolResult: ToolResultEvent;
}

export interface ParsedTrace {
  metadata: Record<string, unknown>;
  source: string;
  turns: ParsedTurn[];
}

export interface ReplacementRecord {
  pointerId: string;
  reason: "staleness" | "supersession" | "pressure" | "co-invalidation";
  toolCallId: string;
  toolName: string;
}

export interface TurnResult {
  baselineTokens: number;
  compiledMessages: number;
  compiledTokens: number;
  contextUsagePercent: number;
  replacedArchives: number;
  replacedChars: number;
  totalArchiveChars: number;
  totalChars: number;
}

export interface TraceResult {
  maxContextUsagePercent: number;
  metadata: Record<string, unknown>;
  replacedCount: number;
  source: string;
  totalArchiveChars: number;
  totalReplacedChars: number;
  turnResults: TurnResult[];
}

export interface AlgorithmResult {
  algorithm: string;
  averageCompressionRatio: number;
  averageKvInvalidationCost: number;
  averageRecallCost: number;
  averageReplacedCount: number;
  maxUsagePercent: number;
  medianUsagePercent: number;
  traceResults: TraceResult[];
}

export interface BenchmarkConfig {
  algorithms: string[];
  cacheDir: string;
  maxTraces: number;
  pressures: number[];
  sources: string[];
}
