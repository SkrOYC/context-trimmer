import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export interface ParsedTurn {
  // File path this turn mutates, if any (from a write/edit tool). Used to
  // synthesize read staleness in the benchmark.
  mutatesPath?: string;
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
  cacheReadTokens: number;
  cacheWriteTokens: number;
  compiledMessages: number;
  compiledTokens: number;
  contextUsagePercent: number;
  inputTokens: number;
  replacedArchives: number;
  replacedChars: number;
  totalArchiveChars: number;
  totalChars: number;
}

export interface TraceResult {
  // Number of turns on which a NEW mid-context replacement forced a KV-cache
  // suffix invalidation beyond the normal append. This is the anti-thrash
  // metric: the decisive-batch policy should keep this low (few, large events)
  // while an incremental policy re-invalidates on many turns.
  invalidationEvents: number;
  // Peak compiled (post-trim) context as a % of the window. A value <= 100 means
  // the trimmer kept every turn inside the window.
  maxCompiledUsagePercent: number;
  maxContextUsagePercent: number;
  metadata: Record<string, unknown>;
  // Sum over turns of tokens exceeding the context window, for the untrimmed
  // baseline and the compiled (trimmed) context. This is the metric that
  // captures the real value of trimming: preventing window overflow / forced
  // compaction in long sessions.
  overflowTokensBaseline: number;
  overflowTokensCompiled: number;
  // Count of evicted read archives whose file the trace's agent read again after
  // the eviction — evidence the content still had value (a would-be recall).
  prematureRecalls: number;
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
