import type { ParsedTrace } from "./types";

export interface ToolFrequency {
  bash: number;
  find: number;
  grep: number;
  ls: number;
  read: number;
  total: number;
}

export interface TraceStats {
  averageObservationChars: number;
  maxObservationChars: number;
  source: string;
  toolFrequency: ToolFrequency;
  totalTurns: number;
}

export function analyzeTrace(trace: ParsedTrace): TraceStats {
  const toolFrequency: ToolFrequency = {
    bash: 0,
    find: 0,
    grep: 0,
    ls: 0,
    read: 0,
    total: trace.turns.length,
  };

  let totalObservationChars = 0;
  let maxObservationChars = 0;

  for (const turn of trace.turns) {
    const { toolName } = turn.toolResult;
    if (toolName in toolFrequency) {
      toolFrequency[toolName as keyof Omit<ToolFrequency, "total">] += 1;
    }

    const observationChars = turn.observation.length;
    totalObservationChars += observationChars;
    maxObservationChars = Math.max(maxObservationChars, observationChars);
  }

  return {
    averageObservationChars:
      trace.turns.length === 0 ? 0 : totalObservationChars / trace.turns.length,
    maxObservationChars,
    source: trace.source,
    toolFrequency,
    totalTurns: trace.turns.length,
  };
}

export function aggregateStats(stats: TraceStats[]): TraceStats {
  const totalTurns = stats.reduce((sum, s) => sum + s.totalTurns, 0);
  const toolFrequency: ToolFrequency = {
    bash: 0,
    find: 0,
    grep: 0,
    ls: 0,
    read: 0,
    total: totalTurns,
  };

  let totalObservationChars = 0;
  let maxObservationChars = 0;

  for (const s of stats) {
    toolFrequency.bash += s.toolFrequency.bash;
    toolFrequency.find += s.toolFrequency.find;
    toolFrequency.grep += s.toolFrequency.grep;
    toolFrequency.ls += s.toolFrequency.ls;
    toolFrequency.read += s.toolFrequency.read;
    totalObservationChars += s.averageObservationChars * s.totalTurns;
    maxObservationChars = Math.max(maxObservationChars, s.maxObservationChars);
  }

  return {
    averageObservationChars:
      totalTurns === 0 ? 0 : totalObservationChars / totalTurns,
    maxObservationChars,
    source: "aggregated",
    toolFrequency,
    totalTurns,
  };
}

export function printStats(stats: TraceStats): void {
  console.log(`\n--- Static analysis (${stats.source}) ---`);
  console.log(`Total turns: ${stats.totalTurns}`);
  console.log(
    `Avg observation chars: ${stats.averageObservationChars.toFixed(0)}`
  );
  console.log(`Max observation chars: ${stats.maxObservationChars}`);
  console.log("Tool frequency:");
  console.log(`  read:  ${stats.toolFrequency.read}`);
  console.log(`  bash:  ${stats.toolFrequency.bash}`);
  console.log(`  grep:  ${stats.toolFrequency.grep}`);
  console.log(`  find:  ${stats.toolFrequency.find}`);
  console.log(`  ls:    ${stats.toolFrequency.ls}`);
}
