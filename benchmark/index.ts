import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptOniTrace } from "./adapter-oni";
import { adaptSweAgentTrace } from "./adapter-swe-agent";
import { adaptToolathlonTrace } from "./adapter-toolathlon";
import { ALGORITHMS } from "./algorithms";
import { aggregateStats, analyzeTrace, printStats } from "./analyze";
import { aggregateCosts, computeTraceDollarCost } from "./cost";
import {
  cacheJsonl,
  cacheText,
  fetchGitHubRawFile,
  fetchHuggingFaceRawFile,
  fetchHuggingFaceRows,
} from "./fetch";
import {
  fetchModelPricing,
  fetchOpencodeGoPricing,
  type ModelPricing,
} from "./pricing";
import { replayTrace } from "./replay";
import type { ParsedTrace, TraceResult } from "./types";

const DEFAULT_CACHE_DIR = join(process.cwd(), ".benchmark-cache");
const SWE_AGENT_DATASET = "nebius/SWE-agent-trajectories";
const SWE_AGENT_CONFIG = "default";
const SWE_AGENT_SPLIT = "train";
const ONI_JSONL_URL =
  "https://raw.githubusercontent.com/makarsuperstar/oni-devops-traces/main/data/distilled_ssh/data.jsonl";
const TOOLATHLON_JSONL_URL =
  "https://huggingface.co/datasets/hkust-nlp/Toolathlon-Trajectories/resolve/main/claude-4.5-opus_1.jsonl";

interface BenchmarkOptions {
  cacheDir: string;
  contextWindows: number[];
  maxOniTraces: number;
  maxSweTraces: number;
  maxToolathlonTraces: number;
  sources: Set<"swe-agent" | "oni-devops" | "toolathlon">;
}

function parseArgs(): BenchmarkOptions {
  const args = process.argv.slice(2);
  const sources: Set<"swe-agent" | "oni-devops"> = new Set();

  if (args.includes("--swe-agent")) {
    sources.add("swe-agent");
  }
  if (args.includes("--oni-devops")) {
    sources.add("oni-devops");
  }
  if (args.includes("--toolathlon")) {
    sources.add("toolathlon");
  }
  if (sources.size === 0) {
    sources.add("swe-agent");
    sources.add("oni-devops");
    sources.add("toolathlon");
  }

  const cacheDir = getArg(args, "--cache-dir") ?? DEFAULT_CACHE_DIR;
  const contextWindowArg = getArg(args, "--context-window");
  const contextWindows = contextWindowArg
    ? contextWindowArg.split(",").map(Number)
    : [200_000];
  const maxSweTraces = Number(getArg(args, "--max-swe") ?? "50");
  const maxOniTraces = Number(getArg(args, "--max-oni") ?? "100");
  const maxToolathlonTraces = Number(getArg(args, "--max-toolathlon") ?? "20");

  return {
    cacheDir,
    contextWindows,
    maxOniTraces,
    maxSweTraces,
    maxToolathlonTraces,
    sources,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return;
  }
  return args[idx + 1];
}

async function loadSweAgentTraces(
  cacheDir: string,
  maxTraces: number
): Promise<ParsedTrace[]> {
  const cachePath = join(cacheDir, "swe-agent-trajectories", "data.jsonl");

  const cachedLines = existsSync(cachePath)
    ? readFileSync(cachePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
    : [];

  if (cachedLines.length < maxTraces) {
    console.log(`Fetching ${maxTraces} SWE-agent trajectories...`);
    const batchSize = 100;
    const records: unknown[] = [];

    const batches = await Promise.all(
      Array.from({ length: Math.ceil(maxTraces / batchSize) }, (_, i) => {
        const offset = i * batchSize;
        const length = Math.min(batchSize, maxTraces - offset);
        return fetchHuggingFaceRows(
          SWE_AGENT_DATASET,
          SWE_AGENT_CONFIG,
          SWE_AGENT_SPLIT,
          offset,
          length
        );
      })
    );

    for (const batch of batches) {
      records.push(...batch);
    }
    console.log(`  fetched ${records.length}/${maxTraces}`);

    cacheJsonl(cacheDir, "swe-agent-trajectories", records);
  }

  const lines = readFileSync(cachePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const traces: ParsedTrace[] = [];
  for (const line of lines) {
    const record = JSON.parse(line) as unknown;
    const trace = adaptSweAgentTrace(record);
    if (trace) {
      traces.push(trace);
    }
  }

  return traces.slice(0, maxTraces);
}

async function loadOniTraces(
  cacheDir: string,
  maxTraces: number
): Promise<ParsedTrace[]> {
  const cachePath = join(cacheDir, "oni-devops-traces", "data.jsonl");

  if (!existsSync(cachePath)) {
    console.log("Fetching oni-devops-traces (distilled_ssh)...");
    const text = await fetchGitHubRawFile(ONI_JSONL_URL);
    cacheText(cacheDir, "oni-devops-traces", "data.jsonl", text);
  }

  const lines = readFileSync(cachePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const traces: ParsedTrace[] = [];
  for (const line of lines.slice(0, maxTraces)) {
    const record = JSON.parse(line) as unknown;
    const trace = adaptOniTrace(record);
    if (trace) {
      traces.push(trace);
    }
  }

  return traces;
}

async function loadToolathlonTraces(
  cacheDir: string,
  maxTraces: number
): Promise<ParsedTrace[]> {
  const cachePath = join(cacheDir, "toolathlon-trajectories", "data.jsonl");

  if (!existsSync(cachePath)) {
    console.log("Fetching Toolathlon trajectories (claude-4.5-opus_1)...");
    const text = await fetchHuggingFaceRawFile(TOOLATHLON_JSONL_URL);
    cacheText(cacheDir, "toolathlon-trajectories", "data.jsonl", text);
  }

  const lines = readFileSync(cachePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  // Toolathlon tasks vary wildly in length. Sort by total message characters
  // so we benchmark the longest, most context-heavy trajectories first.
  const withLength = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    const messagesStr =
      typeof record.messages === "string" ? record.messages : "";
    return { line, messagesLength: messagesStr.length };
  });
  withLength.sort((a, b) => b.messagesLength - a.messagesLength);

  const traces: ParsedTrace[] = [];
  for (const { line } of withLength.slice(0, maxTraces)) {
    const record = JSON.parse(line) as unknown;
    const trace = adaptToolathlonTrace(record);
    if (trace) {
      traces.push(trace);
    }
  }

  return traces;
}

function runBenchmarks(
  traces: ParsedTrace[],
  source: string,
  contextWindow: number
): Map<string, TraceResult[]> {
  const cwd = tmpdir();
  const resultsByAlgorithm = new Map<string, TraceResult[]>();

  for (const [name, selector] of Object.entries(ALGORITHMS)) {
    console.log(`  running ${name}...`);
    const results: TraceResult[] = [];

    for (const trace of traces) {
      try {
        const result = replayTrace(trace, {
          contextWindow,
          cwd,
          selector,
        });
        results.push(result);
      } catch (err) {
        console.warn(
          `    failed to replay trace from ${source}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    resultsByAlgorithm.set(`${source}:${name}`, results);
  }

  return resultsByAlgorithm;
}

function printComparison(
  source: string,
  resultsByAlgorithm: Map<string, TraceResult[]>,
  label?: string
): void {
  console.log(`\n=== Metrics comparison for ${label ?? source} ===`);
  console.log(
    [
      "Algorithm".padEnd(24),
      "Traces".padStart(8),
      "AvgRepl".padStart(10),
      "AvgComp%".padStart(10),
      "AvgKV".padStart(10),
      "AvgRecall".padStart(12),
      "MaxUse%".padStart(10),
    ].join("  ")
  );

  for (const [key, results] of resultsByAlgorithm.entries()) {
    if (!key.startsWith(`${source}:`)) {
      continue;
    }

    const algorithm = key.slice(source.length + 1);
    const costs = results.map((r) => {
      const compressionRatio =
        r.totalArchiveChars === 0
          ? 0
          : r.totalReplacedChars / r.totalArchiveChars;
      const kvInvalidationCost = Math.max(
        ...r.turnResults.map((t) => t.contextUsagePercent),
        0
      );
      return {
        compressionRatio,
        kvInvalidationCost,
        recallCost: r.replacedCount,
        replacedCount: r.replacedCount,
        replacedTokens: r.totalReplacedChars / 4,
        totalTokens: r.totalArchiveChars / 4,
      };
    });

    const aggregated = aggregateCosts(costs);

    const maxUsage = Math.max(...results.map((r) => r.maxContextUsagePercent));

    console.log(
      [
        algorithm.padEnd(24),
        String(results.length).padStart(8),
        aggregated.replacedCount.toFixed(1).padStart(10),
        (aggregated.compressionRatio * 100).toFixed(1).padStart(10),
        aggregated.kvInvalidationCost.toFixed(1).padStart(10),
        aggregated.recallCost.toFixed(1).padStart(12),
        String(maxUsage).padStart(10),
      ].join("  ")
    );
  }
}

function printCostComparison(
  source: string,
  resultsByAlgorithm: Map<string, TraceResult[]>,
  pricing: ModelPricing[]
): void {
  console.log(
    `\n=== Dollar cost comparison for ${source} (models.dev / opencode-go) ===`
  );

  for (const model of pricing) {
    console.log(
      `\n-- ${model.modelName} ($${model.inputPrice}/M in, $${model.outputPrice}/M out) --`
    );
    console.log(
      [
        "Algorithm".padEnd(24),
        "Baseline".padStart(14),
        "Trimmer".padStart(14),
        "Recall".padStart(14),
        "Net savings".padStart(14),
      ].join("  ")
    );

    for (const [key, results] of resultsByAlgorithm.entries()) {
      if (!key.startsWith(`${source}:`)) {
        continue;
      }

      const algorithm = key.slice(source.length + 1);
      const dollarCosts = results.map((r) => computeTraceDollarCost(r, model));

      const avgBaseline =
        dollarCosts.reduce((sum, c) => sum + c.baselineCost, 0) /
        dollarCosts.length;
      const avgTrimmer =
        dollarCosts.reduce((sum, c) => sum + c.trimmerCost, 0) /
        dollarCosts.length;
      const avgRecall =
        dollarCosts.reduce((sum, c) => sum + c.recallCost, 0) /
        dollarCosts.length;
      const avgSavings =
        dollarCosts.reduce((sum, c) => sum + c.netSavings, 0) /
        dollarCosts.length;

      console.log(
        [
          algorithm.padEnd(24),
          `$${avgBaseline.toFixed(4)}`.padStart(14),
          `$${avgTrimmer.toFixed(4)}`.padStart(14),
          `$${avgRecall.toFixed(4)}`.padStart(14),
          `$${avgSavings.toFixed(4)}`.padStart(14),
        ].join("  ")
      );
    }
  }
}

async function processSource(
  source: "swe-agent" | "oni-devops" | "toolathlon",
  loader: (cacheDir: string, max: number) => Promise<ParsedTrace[]>,
  maxTraces: number,
  options: BenchmarkOptions,
  pricing: ModelPricing[],
  allResults: Map<string, TraceResult[]>
): Promise<void> {
  console.log(`\n--- Loading ${source} trajectories ---`);
  const traces = await loader(options.cacheDir, maxTraces);
  console.log(`Loaded ${traces.length} ${source} traces`);

  const stats = traces.map(analyzeTrace);
  printStats(aggregateStats(stats));

  for (const contextWindow of options.contextWindows) {
    console.log(`\n--- Context window: ${contextWindow.toLocaleString()} ---`);
    const results = runBenchmarks(traces, source, contextWindow);
    for (const [key, value] of results.entries()) {
      allResults.set(`${key}:${contextWindow}`, value);
    }
    printComparison(
      source,
      results,
      `${source} @ ${contextWindow.toLocaleString()}`
    );
    printCostComparison(source, results, pricing);
  }
}

async function main(): Promise<void> {
  const options = parseArgs();

  if (!existsSync(options.cacheDir)) {
    mkdirSync(options.cacheDir, { recursive: true });
  }

  console.log("\n--- Fetching models.dev / opencode-go pricing ---");
  const pricing = await fetchOpencodeGoPricing(options.cacheDir);
  console.log(`Loaded ${pricing.length} model price cards`);

  console.log("\n--- Fetching Claude 4.5 Opus pricing ---");
  const copilotOpus = await fetchModelPricing(
    options.cacheDir,
    "github-copilot",
    "claude-opus-4.5"
  );
  if (copilotOpus) {
    pricing.push(copilotOpus);
    console.log(`  Loaded ${copilotOpus.modelName} from github-copilot`);
  }
  const neonOpus = await fetchModelPricing(
    options.cacheDir,
    "neon",
    "claude-opus-4-5"
  );
  if (neonOpus) {
    pricing.push(neonOpus);
    console.log(`  Loaded ${neonOpus.modelName} from neon`);
  }

  const allResults = new Map<string, TraceResult[]>();

  if (options.sources.has("swe-agent")) {
    await processSource(
      "swe-agent",
      loadSweAgentTraces,
      options.maxSweTraces,
      options,
      pricing,
      allResults
    );
  }

  if (options.sources.has("oni-devops")) {
    await processSource(
      "oni-devops",
      loadOniTraces,
      options.maxOniTraces,
      options,
      pricing,
      allResults
    );
  }

  if (options.sources.has("toolathlon")) {
    await processSource(
      "toolathlon",
      loadToolathlonTraces,
      options.maxToolathlonTraces,
      options,
      pricing,
      allResults
    );
  }

  const reportPath = join(options.cacheDir, "benchmark-report.json");
  const report: Record<string, unknown> = {};
  for (const [key, value] of allResults.entries()) {
    report[key] = value.map((r) => ({
      maxContextUsagePercent: r.maxContextUsagePercent,
      metadata: r.metadata,
      replacedCount: r.replacedCount,
      source: r.source,
      totalArchiveChars: r.totalArchiveChars,
      totalReplacedChars: r.totalReplacedChars,
      turnResults: r.turnResults,
    }));
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\nReport written to ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
