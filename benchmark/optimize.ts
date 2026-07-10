import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextUsage } from "../src/eviction";
import { computeArchiveMetrics } from "../src/supersession";
import { checkStalenessBatch } from "../src/utils";
import { adaptToolathlonTrace } from "./adapter-toolathlon";
import type { CandidateSelector } from "./algorithms";
import { computeTraceDollarCost } from "./cost";
import { fetchModelPricing, type ModelPricing } from "./pricing";
import { replayTrace } from "./replay";
import type { ArchivedResult, ParsedTrace } from "./types";

const CACHE_DIR = join(process.cwd(), ".benchmark-cache");

interface Params {
  coInvalidationBoost: number;
  pressureWeight: number;
  recencyWeight: number;
  softPressureThreshold: number;
  stalenessWeight: number;
  supersessionWeight: number;
}

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

function computePressureScore(percent: number, params: Params): number {
  if (percent <= params.softPressureThreshold) {
    return 0;
  }
  const range = 100 - params.softPressureThreshold;
  const progress = Math.min(
    (percent - params.softPressureThreshold) / range,
    1
  );
  return progress * params.pressureWeight;
}

function computeEvictionScore(
  m: { index: number; pointerId: string; coverage: number; threshold: number },
  isStale: boolean,
  totalMessages: number,
  pressureScore: number,
  firstReplacementIndex: number,
  params: Params
): number {
  const recencyRatio = m.index / (totalMessages - 1 || 1);

  let score = 0;
  if (isStale) {
    score += params.stalenessWeight;
  }
  score += Math.min(m.coverage / m.threshold, 1.0) * params.supersessionWeight;
  score += pressureScore;
  score += recencyRatio * params.recencyWeight;

  const hasEvictionSignal = isStale || m.coverage > 0;
  if (m.index >= firstReplacementIndex && hasEvictionSignal) {
    score += params.coInvalidationBoost;
  }

  return score;
}

function makeEvictionSelector(params: Params): CandidateSelector {
  return (
    messages: AgentMessage[],
    archivesByPath: Map<string, ArchivedResult[]>,
    activeArchives: Map<string, ArchivedResult>,
    usage: ContextUsage,
    cwd: string
  ): Set<string> => {
    const toReplace = new Set<string>();
    const percent = usage.percent ?? 0;

    if (percent < params.softPressureThreshold) {
      return toReplace;
    }

    const metrics = computeArchiveMetrics(messages, archivesByPath).sort(
      (a, b) => a.index - b.index
    );
    if (metrics.length === 0) {
      return toReplace;
    }

    const candidateArchives = metrics
      .map((m) => activeArchives.get(m.pointerId))
      .filter((arc): arc is ArchivedResult => arc !== undefined);

    const staleByPointer = checkStalenessBatch(candidateArchives, cwd);
    const totalMessages = messages.length;
    const pressureScore = computePressureScore(percent, params);
    const scoreThreshold = 1.0; // Locked constant threshold

    let firstReplacementIndex = Number.POSITIVE_INFINITY;

    for (const m of metrics) {
      const arc = activeArchives.get(m.pointerId);
      if (!arc) {
        continue;
      }

      const isStale = staleByPointer.get(m.pointerId) ?? false;
      const score = computeEvictionScore(
        m,
        isStale,
        totalMessages,
        pressureScore,
        firstReplacementIndex,
        params
      );

      if (score >= scoreThreshold) {
        toReplace.add(m.pointerId);
        firstReplacementIndex = Math.min(firstReplacementIndex, m.index);
      }
    }

    return toReplace;
  };
}

function evaluateConfig(
  params: Params,
  traces: ParsedTrace[],
  pricing: ModelPricing,
  cwd: string
): number {
  const selector = makeEvictionSelector(params);
  let totalTrimmerCost = 0;
  let totalBaselineCost = 0;

  for (const trace of traces) {
    const result = replayTrace(trace, {
      contextWindow: 200_000,
      cwd,
      selector,
    });

    const cost = computeTraceDollarCost(result, pricing);
    const trimmerCostWithoutRecall = cost.trimmerCost - cost.recallCost;
    const scaledRecallCost = cost.recallCost * 0.2;
    const totalScaledCost = trimmerCostWithoutRecall + scaledRecallCost;

    totalTrimmerCost += totalScaledCost;
    totalBaselineCost += cost.baselineCost;
  }

  return totalBaselineCost - totalTrimmerCost;
}

function getRandomVal(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function generateRandomParams(): Params {
  const soft = Math.floor(getRandomVal(10, 90));
  return {
    coInvalidationBoost: getRandomVal(0, 1.0),
    pressureWeight: getRandomVal(0, 1.0),
    recencyWeight: getRandomVal(0, 1.0),
    softPressureThreshold: soft,
    stalenessWeight: getRandomVal(0, 1.0),
    supersessionWeight: getRandomVal(0, 1.0),
  };
}

function cloneParams(p: Params): Params {
  return { ...p };
}

function getNeighbors(p: Params): Params[] {
  const neighbors: Params[] = [];
  const step = 0.05;

  const keys: Array<keyof Params> = [
    "coInvalidationBoost",
    "pressureWeight",
    "recencyWeight",
    "softPressureThreshold",
    "stalenessWeight",
    "supersessionWeight",
  ];

  for (const key of keys) {
    if (key === "softPressureThreshold") {
      const n1 = cloneParams(p);
      n1[key] = p[key] + 5;
      const n2 = cloneParams(p);
      n2[key] = p[key] - 5;
      neighbors.push(n1, n2);
    } else {
      const n1 = cloneParams(p);
      n1[key] = p[key] + step;
      const n2 = cloneParams(p);
      n2[key] = p[key] - step;
      neighbors.push(n1, n2);
    }
  }

  return neighbors;
}

async function main() {
  console.log("Loading traces and pricing...");
  const traces = loadToolathlonTraces();
  const pricing = await fetchModelPricing(
    CACHE_DIR,
    "github-copilot",
    "claude-opus-4.5"
  );
  if (!pricing) {
    throw new Error("Opus pricing missing.");
  }
  const cwd = tmpdir();

  console.log("Stage 1: Random Search (Coarse Sweep, 1000 samples)...");
  const candidates: Array<{ params: Params; savings: number }> = [];

  for (let i = 0; i < 1000; i += 1) {
    const p = generateRandomParams();
    const savings = evaluateConfig(p, traces, pricing, cwd);
    candidates.push({ params: p, savings });
  }

  candidates.sort((a, b) => b.savings - a.savings);
  const topCandidates = candidates.slice(0, 10);

  console.log("Stage 2: Local Coordinate Descent (Hill Climbing)...");
  const [firstCandidate] = topCandidates;
  if (!firstCandidate) {
    throw new Error("No candidates evaluated.");
  }
  let bestParams = firstCandidate.params;
  let bestSavings = firstCandidate.savings;

  for (const cand of topCandidates) {
    let current = cloneParams(cand.params);
    let currentSavings = cand.savings;
    let improved = true;

    while (improved) {
      improved = false;
      const neighbors = getNeighbors(current);
      for (const n of neighbors) {
        if (
          n.softPressureThreshold < 10 ||
          n.softPressureThreshold > 90 ||
          n.stalenessWeight < 0 ||
          n.stalenessWeight > 1.0 ||
          n.supersessionWeight < 0 ||
          n.supersessionWeight > 1.0 ||
          n.pressureWeight < 0 ||
          n.pressureWeight > 1.0 ||
          n.recencyWeight < 0 ||
          n.recencyWeight > 1.0 ||
          n.coInvalidationBoost < 0 ||
          n.coInvalidationBoost > 1.0
        ) {
          continue;
        }

        const s = evaluateConfig(n, traces, pricing, cwd);
        if (s > currentSavings) {
          currentSavings = s;
          current = n;
          improved = true;
        }
      }
    }

    if (currentSavings > bestSavings) {
      bestSavings = currentSavings;
      bestParams = current;
    }
  }

  console.log("\n=== NORMALIZED OPTIMIZATION RESULTS (Threshold = 1.0) ===");
  console.log("Best Weight Configuration:");
  console.log(JSON.stringify(bestParams, null, 2));
  console.log("Optimized Dollar Savings:", bestSavings.toFixed(4));
}

main().catch(console.error);
