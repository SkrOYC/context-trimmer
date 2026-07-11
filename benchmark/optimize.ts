import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EVICTION_CONFIG,
  type EvictionConfig,
  type EvictionWeights,
} from "../src/eviction";
import { adaptToolathlonTrace } from "./adapter-toolathlon";
import { makeProduction } from "./algorithms";
import { replayTrace } from "./replay";
import type { ParsedTrace } from "./types";

const CACHE_DIR = join(process.cwd(), ".benchmark-cache");
const CONTEXT_WINDOW = 200_000;
const HOLDOUT_STRIDE = 3;

// Objective = mean compiled context usage (the dumb-zone cost we minimize)
//           + LAMBDA * invalidation rate      (KV-cache-miss counter-term)
//           + MU     * premature-recall rate  (info-loss counter-term)
// Overflow is a hard constraint: any config that overflows the window is
// infeasible (objective = Infinity) because those turns force compaction or a
// request failure in a live agent. LAMBDA prices a cache-miss event; MU prices
// evicting content the trace's agent later came back to. Without MU the search
// collapses the context to near-empty, since losing information is otherwise
// free. Both are per-turn-normalized so the terms are comparable.
const LAMBDA = 0.4;
const MU = 0.6;

const SEMANTIC_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;
const WEIGHT_KEYS: (keyof EvictionWeights)[] = [
  "affordability",
  "coldness",
  "pressure",
  "semantic",
  "size",
  "staleness",
  "supersession",
];

const GRID = {
  immutableStalenessConfidence: [0.2, 0.4, 0.6, 0.8, 1.0],
  semantic: [0.2, 0.35, 0.5, 0.65, 0.8],
  weight: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4],
};

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
  for (const { line } of withLength.slice(0, 20)) {
    const record = JSON.parse(line) as unknown;
    const trace = adaptToolathlonTrace(record);
    if (trace) {
      traces.push(trace);
    }
  }
  return traces;
}

interface Evaluation {
  invalidationRate: number;
  meanUsage: number;
  objective: number;
  overflow: number;
  prematureRecallRate: number;
}

function evaluate(config: EvictionConfig, traces: ParsedTrace[]): Evaluation {
  const selector = makeProduction(config);
  let overflow = 0;
  let usageSum = 0;
  let turnCount = 0;
  let invalidationEvents = 0;
  let prematureRecalls = 0;

  for (const trace of traces) {
    const result = replayTrace(trace, {
      contextWindow: CONTEXT_WINDOW,
      cwd: tmpdir(),
      selector,
    });
    overflow += result.overflowTokensCompiled;
    invalidationEvents += result.invalidationEvents;
    prematureRecalls += result.prematureRecalls;
    for (const turn of result.turnResults) {
      usageSum += turn.compiledTokens / CONTEXT_WINDOW;
      turnCount += 1;
    }
  }

  const meanUsage = turnCount === 0 ? 0 : usageSum / turnCount;
  const invalidationRate = turnCount === 0 ? 0 : invalidationEvents / turnCount;
  const prematureRecallRate =
    turnCount === 0 ? 0 : prematureRecalls / turnCount;
  const objective =
    overflow > 0
      ? Number.POSITIVE_INFINITY
      : meanUsage + LAMBDA * invalidationRate + MU * prematureRecallRate;

  return {
    invalidationRate,
    meanUsage,
    objective,
    overflow,
    prematureRecallRate,
  };
}

/** Set one weight to `value` and renormalize the rest so the shares sum to 1. */
function withWeight(
  config: EvictionConfig,
  key: keyof EvictionWeights,
  value: number
): EvictionConfig {
  const others = WEIGHT_KEYS.filter((k) => k !== key);
  const otherSum = others.reduce((s, k) => s + config.weights[k], 0);
  const remaining = 1 - value;
  const weights = { ...config.weights, [key]: value };
  for (const k of others) {
    weights[k] =
      otherSum > 0
        ? (config.weights[k] / otherSum) * remaining
        : remaining / others.length;
  }
  return { ...config, weights };
}

interface Move {
  apply: (config: EvictionConfig, value: number) => EvictionConfig;
  label: string;
  values: number[];
}

function buildMoves(): Move[] {
  const moves: Move[] = [];

  for (const key of WEIGHT_KEYS) {
    moves.push({
      apply: (config, value) => withWeight(config, key, value),
      label: `weight.${key}`,
      values: GRID.weight,
    });
  }

  // Only the honestly-learnable parameters are searched. The aggressiveness
  // knobs (threshold, pressure knees, minBatchTokens) are fixed by principle in
  // DEFAULT_EVICTION_CONFIG: replay cannot measure the cost of over-trimming, so
  // letting the optimizer set aggressiveness would collapse the context to
  // near-empty. What it CAN rank honestly is the relative weight of each signal
  // and each tool's disposability.
  moves.push({
    apply: (config, value) => ({
      ...config,
      immutableStalenessConfidence: value,
    }),
    label: "immutableStalenessConfidence",
    values: GRID.immutableStalenessConfidence,
  });

  for (const tool of SEMANTIC_TOOLS) {
    moves.push({
      apply: (config, value) => ({
        ...config,
        semanticByTool: { ...config.semanticByTool, [tool]: value },
      }),
      label: `semantic.${tool}`,
      values: GRID.semantic,
    });
  }

  return moves;
}

function coordinateDescent(
  start: EvictionConfig,
  train: ParsedTrace[],
  rounds: number
): EvictionConfig {
  const moves = buildMoves();
  let best = start;
  let bestEval = evaluate(best, train);
  console.log(
    `start: objective=${bestEval.objective.toFixed(4)} (usage=${(bestEval.meanUsage * 100).toFixed(1)}%, invalRate=${bestEval.invalidationRate.toFixed(3)})`
  );

  for (let round = 1; round <= rounds; round += 1) {
    let improvedThisRound = false;

    for (const move of moves) {
      let localBest = best;
      let localEval = bestEval;

      for (const value of move.values) {
        const trial = move.apply(best, value);
        const trialEval = evaluate(trial, train);
        if (trialEval.objective < localEval.objective - 1e-9) {
          localBest = trial;
          localEval = trialEval;
        }
      }

      if (localEval.objective < bestEval.objective - 1e-9) {
        best = localBest;
        bestEval = localEval;
        improvedThisRound = true;
        console.log(
          `  round ${round}: ${move.label.padEnd(28)} -> objective=${bestEval.objective.toFixed(4)} (usage=${(bestEval.meanUsage * 100).toFixed(1)}%, invalRate=${bestEval.invalidationRate.toFixed(3)})`
        );
      }
    }

    if (!improvedThisRound) {
      console.log(`  round ${round}: no improvement, converged.`);
      break;
    }
  }

  return best;
}

function printConfig(config: EvictionConfig): void {
  console.log("\nLearned config:");
  console.log("  weights:");
  for (const key of WEIGHT_KEYS) {
    console.log(`    ${key.padEnd(14)} ${config.weights[key].toFixed(3)}`);
  }
  console.log(`  threshold                 ${config.threshold.toFixed(3)}`);
  console.log(
    `  immutableStalenessConf    ${config.immutableStalenessConfidence.toFixed(3)}`
  );
  console.log(
    `  pressurePercentKnee       ${config.pressurePercentKnee.toFixed(3)}`
  );
  console.log(
    `  pressureAbsoluteKnee      ${config.pressureAbsoluteKnee.toLocaleString()}`
  );
  console.log(
    `  minBatchTokens            ${config.minBatchTokens.toLocaleString()}`
  );
  console.log("  semanticByTool:");
  for (const tool of SEMANTIC_TOOLS) {
    console.log(
      `    ${tool.padEnd(6)} ${(config.semanticByTool[tool] ?? 0).toFixed(3)}`
    );
  }
}

function printEval(label: string, e: Evaluation): void {
  console.log(
    `${label.padEnd(10)} objective=${e.objective.toFixed(4)}  meanUsage=${(e.meanUsage * 100).toFixed(1)}%  invalRate=${e.invalidationRate.toFixed(3)}  recallRate=${e.prematureRecallRate.toFixed(3)}  overflow=${e.overflow.toLocaleString()}`
  );
}

function main() {
  const all = loadToolathlonTraces();
  const train: ParsedTrace[] = [];
  const holdout: ParsedTrace[] = [];
  all.forEach((trace, i) => {
    if (i % HOLDOUT_STRIDE === 0) {
      holdout.push(trace);
    } else {
      train.push(trace);
    }
  });

  console.log(
    `Coordinate-descent search over ${buildMoves().length} parameters.`
  );
  console.log(
    `Objective = mean context usage + ${LAMBDA} * invalidation rate + ${MU} * recall rate, overflow=0 hard.\n`
  );
  console.log(`Train: ${train.length} traces, holdout: ${holdout.length}.\n`);

  const learned = coordinateDescent(DEFAULT_EVICTION_CONFIG, train, 6);

  printConfig(learned);

  console.log("");
  const learnedHoldout = evaluate(learned, holdout);
  const baselineHoldout = evaluate(DEFAULT_EVICTION_CONFIG, holdout);
  printEval("learn/train", evaluate(learned, train));
  printEval("learn/hold", learnedHoldout);
  printEval("princ/hold", baselineHoldout);

  // Honest guard against overfitting: only adopt the learned weights if they
  // actually generalize. With aggressiveness fixed and the over-trim exploit
  // closed, the learned weights typically overfit the train split and do NOT
  // beat the principled defaults out-of-sample — in which case we ship the
  // principled config. The value lives in the structure, not the fine weights.
  if (learnedHoldout.objective < baselineHoldout.objective - 1e-4) {
    console.log(
      "\nLearned weights generalize (beat principled defaults on holdout)."
    );
    console.log("Consider adopting them in src/eviction.ts.");
  } else {
    console.log(
      "\nLearned weights DO NOT beat the principled defaults on holdout"
    );
    console.log(
      "(they overfit the train split). Keep DEFAULT_EVICTION_CONFIG as shipped."
    );
  }
}

main();
