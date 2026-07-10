import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptToolathlonTrace } from "./adapter-toolathlon";
import { makeOptimizedCacheAware } from "./algorithms";
import { computeTraceDollarCost } from "./cost";
import { fetchModelPricing, type ModelPricing } from "./pricing";
import { replayTrace } from "./replay";
import type { ParsedTrace } from "./types";

const CACHE_DIR = join(process.cwd(), ".benchmark-cache");

function loadToolathlonTraces(): ParsedTrace[] {
  const cachePath = join(CACHE_DIR, "toolathlon-trajectories", "data.jsonl");
  if (!existsSync(cachePath)) {
    throw new Error(
      "Toolathlon trajectories cache missing! Run bun run benchmark first."
    );
  }
  const lines = readFileSync(cachePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  const withLength = lines.map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    const messagesStr =
      typeof record.messages === "string" ? record.messages : "";
    return { line, messagesLength: messagesStr.length };
  });
  withLength.sort((a, b) => b.messagesLength - a.messagesLength);

  const traces: ParsedTrace[] = [];
  // Use top 20 traces for evaluation
  for (const { line } of withLength.slice(0, 20)) {
    const record = JSON.parse(line) as unknown;
    const trace = adaptToolathlonTrace(record);
    if (trace) {
      traces.push(trace);
    }
  }
  return traces;
}

interface DecisionConfig {
  maxTurns: number;
  pRecallActive: number;
  pRecallPartial: number;
  pRecallStale: number;
}

function runConfig(
  config: DecisionConfig,
  traces: ParsedTrace[],
  pricing: ModelPricing,
  cwd: string
): { trimmerCost: number; baselineCost: number } {
  const selector = makeOptimizedCacheAware(config);
  let totalTrimmerCost = 0;
  let totalBaselineCost = 0;

  for (const trace of traces) {
    const result = replayTrace(trace, {
      contextWindow: 200_000,
      cwd,
      selector,
    });

    const cost = computeTraceDollarCost(result, pricing);
    totalTrimmerCost += cost.trimmerCost;
    totalBaselineCost += cost.baselineCost;
  }

  return { baselineCost: totalBaselineCost, trimmerCost: totalTrimmerCost };
}

interface SweepResult {
  baselineTotalCost: number;
  bestConfig: {
    maxTurns: number;
    pRecallActive: number;
    pRecallPartial: number;
    pRecallStale: number;
    trimmerCost?: number;
  } | null;
  bestSavings: number;
}

function performSweep(
  traces: ParsedTrace[],
  pricing: ModelPricing,
  cwd: string
): SweepResult {
  const pRecallActiveOptions = [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0];
  const pRecallStaleOptions = [0.01, 0.05, 0.1];
  const pRecallPartialOptions = [0.05, 0.1, 0.15, 0.25];
  const maxTurnsOptions = [30, 45, 60];

  let bestConfig: SweepResult["bestConfig"] = null;
  let bestSavings = Number.NEGATIVE_INFINITY;
  let baselineTotalCost = 0;
  let baselineComputed = false;

  for (const pActive of pRecallActiveOptions) {
    for (const pStale of pRecallStaleOptions) {
      for (const pPartial of pRecallPartialOptions) {
        for (const maxTurns of maxTurnsOptions) {
          const config = {
            maxTurns,
            pRecallActive: pActive,
            pRecallPartial: pPartial,
            pRecallStale: pStale,
          };

          const { baselineCost, trimmerCost } = runConfig(
            config,
            traces,
            pricing,
            cwd
          );

          if (!baselineComputed) {
            baselineTotalCost = baselineCost;
            baselineComputed = true;
          }

          const savings = baselineCost - trimmerCost;
          if (savings > bestSavings) {
            bestSavings = savings;
            bestConfig = { ...config, trimmerCost };
          }
        }
      }
    }
  }

  return { baselineTotalCost, bestConfig, bestSavings };
}

async function main() {
  console.log("Loading Toolathlon traces...");
  const traces = loadToolathlonTraces();
  console.log(`Loaded ${traces.length} traces.`);

  console.log("Loading pricing for Claude 4.5 Opus (github-copilot)...");
  const pricing = await fetchModelPricing(
    CACHE_DIR,
    "github-copilot",
    "claude-opus-4.5"
  );
  if (!pricing) {
    throw new Error("Opus pricing not found.");
  }

  const cwd = tmpdir();
  const { baselineTotalCost, bestConfig, bestSavings } = performSweep(
    traces,
    pricing,
    cwd
  );

  console.log("\n=== Hyperparameter Sweep Results ===");
  console.log("Baseline total cost:", baselineTotalCost.toFixed(4));
  if (bestConfig) {
    console.log("Best Config found:");
    console.log(JSON.stringify(bestConfig, null, 2));
    console.log("Best Savings:", bestSavings.toFixed(4));
    console.log(
      `Savings %: ${((bestSavings / baselineTotalCost) * 100).toFixed(2)}%`
    );
  }
}

main().catch(console.error);
