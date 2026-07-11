import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptToolathlonTrace } from "./adapter-toolathlon";
import { ALGORITHMS } from "./algorithms";
import { aggregateStats, analyzeTrace, printStats } from "./analyze";
import { computeTraceDollarCost } from "./cost";
import { cacheText, fetchHuggingFaceRawFile } from "./fetch";
import {
  fetchModelPricing,
  fetchOpencodeGoPricing,
  type ModelPricing,
} from "./pricing";
import { replayTrace } from "./replay";
import type { ParsedTrace, TraceResult } from "./types";

// Toolathlon is the only benchmark source: it is the only public dataset with
// trajectories long enough to cross the context window and exercise the
// trimmer's eviction logic. Shorter datasets (SWE-agent ~32% peak, oni-devops
// ~1%) never approach window pressure, so replaying them only confirms the
// trimmer correctly does nothing — noise, not signal. See benchmark/README.md.
const DEFAULT_CACHE_DIR = join(process.cwd(), ".benchmark-cache");
const TOOLATHLON_JSONL_URL =
  "https://huggingface.co/datasets/hkust-nlp/Toolathlon-Trajectories/resolve/main/claude-4.5-opus_1.jsonl";
const SOURCE = "toolathlon";

interface BenchmarkOptions {
  cacheDir: string;
  contextWindows: number[];
  maxToolathlonTraces: number;
  recallRate: number;
}

function parseArgs(): BenchmarkOptions {
  const args = process.argv.slice(2);

  const cacheDir = getArg(args, "--cache-dir") ?? DEFAULT_CACHE_DIR;
  const contextWindowArg = getArg(args, "--context-window");
  const contextWindows = contextWindowArg
    ? contextWindowArg.split(",").map(Number)
    : [200_000];
  const maxToolathlonTraces = Number(getArg(args, "--max-toolathlon") ?? "20");
  const recallRate = Number(getArg(args, "--recall-rate") ?? "0.02");

  return {
    cacheDir,
    contextWindows,
    maxToolathlonTraces,
    recallRate,
  };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return;
  }
  return args[idx + 1];
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
  contextWindow: number
): Map<string, TraceResult[]> {
  const cwd = tmpdir();
  const resultsByAlgorithm = new Map<string, TraceResult[]>();

  for (const [name, selector] of Object.entries(ALGORITHMS)) {
    console.log(`  running ${name}...`);
    const results: TraceResult[] = [];

    for (const trace of traces) {
      try {
        const result = replayTrace(trace, { contextWindow, cwd, selector });
        results.push(result);
      } catch (err) {
        console.warn(
          "    failed to replay trace:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    resultsByAlgorithm.set(name, results);
  }

  return resultsByAlgorithm;
}

function printComparison(
  resultsByAlgorithm: Map<string, TraceResult[]>,
  label: string
): void {
  console.log(`\n=== Metrics comparison for ${label} ===`);
  console.log(
    [
      "Algorithm".padEnd(24),
      "Traces".padStart(8),
      "AvgRepl".padStart(10),
      "Comp%".padStart(8),
      "MaxUse%".padStart(10),
      "MaxCompUse%".padStart(12),
      "OverflowTok".padStart(14),
      "InvalEvents".padStart(12),
    ].join("  ")
  );

  for (const [algorithm, results] of resultsByAlgorithm.entries()) {
    if (results.length === 0) {
      continue;
    }

    const avgReplaced =
      results.reduce((sum, r) => sum + r.replacedCount, 0) / results.length;
    const compressionRatio =
      results.reduce(
        (sum, r) =>
          sum +
          (r.totalArchiveChars === 0
            ? 0
            : r.totalReplacedChars / r.totalArchiveChars),
        0
      ) / results.length;
    const maxUsage = Math.max(...results.map((r) => r.maxContextUsagePercent));
    const maxCompiledUsage = Math.max(
      ...results.map((r) => r.maxCompiledUsagePercent)
    );
    const overflowCompiled = results.reduce(
      (sum, r) => sum + r.overflowTokensCompiled,
      0
    );
    const avgInvalidationEvents =
      results.reduce((sum, r) => sum + r.invalidationEvents, 0) /
      results.length;

    console.log(
      [
        algorithm.padEnd(24),
        String(results.length).padStart(8),
        avgReplaced.toFixed(1).padStart(10),
        (compressionRatio * 100).toFixed(1).padStart(8),
        String(maxUsage).padStart(10),
        String(maxCompiledUsage).padStart(12),
        overflowCompiled.toLocaleString().padStart(14),
        avgInvalidationEvents.toFixed(1).padStart(12),
      ].join("  ")
    );
  }
}

function printCostComparison(
  resultsByAlgorithm: Map<string, TraceResult[]>,
  pricing: ModelPricing[],
  recallRate: number
): void {
  console.log(
    "\n=== Dollar cost comparison (models.dev / opencode-go," +
      ` recall-rate=${recallRate}) ===`
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

    for (const [algorithm, results] of resultsByAlgorithm.entries()) {
      if (results.length === 0) {
        continue;
      }

      const dollarCosts = results.map((r) =>
        computeTraceDollarCost(r, model, recallRate)
      );

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

  console.log("\n--- Loading Toolathlon trajectories ---");
  const traces = await loadToolathlonTraces(
    options.cacheDir,
    options.maxToolathlonTraces
  );
  console.log(`Loaded ${traces.length} toolathlon traces`);

  const stats = traces.map(analyzeTrace);
  printStats(aggregateStats(stats));

  for (const contextWindow of options.contextWindows) {
    console.log(`\n--- Context window: ${contextWindow.toLocaleString()} ---`);
    const results = runBenchmarks(traces, contextWindow);
    for (const [key, value] of results.entries()) {
      allResults.set(`${SOURCE}:${key}:${contextWindow}`, value);
    }
    printComparison(results, `${SOURCE} @ ${contextWindow.toLocaleString()}`);
    printCostComparison(results, pricing, options.recallRate);
  }

  const reportPath = join(options.cacheDir, "benchmark-report.json");
  const report: Record<string, unknown> = {};
  for (const [key, value] of allResults.entries()) {
    report[key] = value.map((r) => ({
      invalidationEvents: r.invalidationEvents,
      maxCompiledUsagePercent: r.maxCompiledUsagePercent,
      maxContextUsagePercent: r.maxContextUsagePercent,
      metadata: r.metadata,
      overflowTokensBaseline: r.overflowTokensBaseline,
      overflowTokensCompiled: r.overflowTokensCompiled,
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
