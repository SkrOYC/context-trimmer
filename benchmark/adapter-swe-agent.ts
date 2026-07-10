import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ParsedTrace, ParsedTurn } from "./types";

interface SweAgentTrajectoryRow {
  exit_status?: string;
  instance_id: string;
  model_name?: string;
  target?: boolean;
  trajectory?: Array<{
    role: string;
    text: string | null;
  }>;
}

type SupportedToolName = "bash" | "find" | "grep" | "ls" | "read";

interface ParsedCommand {
  args: Record<string, unknown>;
  toolName: SupportedToolName;
}

const BUILT_IN_COMMANDS = new Set([
  "open",
  "goto",
  "scroll_down",
  "scroll_up",
  "create",
  "submit",
  "search_dir",
  "search_file",
  "find_file",
  "edit",
]);

const CODE_BLOCK_REGEX = /```\s*\n?([\s\S]*?)```/;
const WHITESPACE_REGEX = /\s+/;

function parseReadCommand(
  firstArg: string | undefined,
  secondArg: string | undefined
): ParsedCommand | undefined {
  if (!firstArg) {
    return;
  }
  const offset = secondArg ? Number(secondArg) : 1;
  return {
    args: { offset: Number.isNaN(offset) ? 1 : offset, path: firstArg },
    toolName: "read",
  };
}

function parseSearchCommand(
  firstArg: string | undefined,
  secondArg: string | undefined,
  toolName: "find" | "grep"
): ParsedCommand | undefined {
  if (!firstArg) {
    return;
  }
  return {
    args: { ...(secondArg && { path: secondArg }), pattern: firstArg },
    toolName,
  };
}

function isSkippedCommand(command: string): boolean {
  return (
    command === "goto" ||
    command === "scroll_down" ||
    command === "scroll_up" ||
    command === "create" ||
    command === "edit" ||
    command === "submit" ||
    BUILT_IN_COMMANDS.has(command)
  );
}

function parseCommand(text: string): ParsedCommand | undefined {
  const codeBlockMatch = text.match(CODE_BLOCK_REGEX);
  if (!codeBlockMatch) {
    return;
  }

  const commandText = codeBlockMatch[1].trim();
  if (commandText.length === 0) {
    return;
  }

  const lines = commandText.split("\n");
  const firstLine = lines[0]?.trim() ?? "";
  const [command, firstArg, secondArg] = firstLine.split(WHITESPACE_REGEX);

  if (!command) {
    return;
  }

  if (command === "open") {
    return parseReadCommand(firstArg, secondArg);
  }

  if (command === "search_file" || command === "search_dir") {
    return parseSearchCommand(firstArg, secondArg, "grep");
  }

  if (command === "find_file") {
    return parseSearchCommand(firstArg, secondArg, "find");
  }

  if (isSkippedCommand(command)) {
    return;
  }

  return {
    args: { command: commandText },
    toolName: "bash",
  };
}

function makeToolResultEvent(
  toolCallId: string,
  parsed: ParsedCommand,
  observation: string
): ToolResultEvent {
  return {
    content: [{ text: observation, type: "text" as const }],
    details: undefined,
    input: parsed.args,
    isError: false,
    toolCallId,
    toolName: parsed.toolName,
    type: "tool_result" as const,
  };
}

function isValidSweAgentRow(row: unknown): row is SweAgentTrajectoryRow {
  if (typeof row !== "object" || row === null) {
    return false;
  }
  const candidate = row as Record<string, unknown>;
  if (typeof candidate.instance_id !== "string") {
    return false;
  }
  if (!Array.isArray(candidate.trajectory)) {
    return false;
  }
  return candidate.trajectory.every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).role === "string"
  );
}

export function adaptSweAgentTrace(row: unknown): ParsedTrace | undefined {
  if (!isValidSweAgentRow(row)) {
    return;
  }

  const typedRow = row;
  const turns: ParsedTurn[] = [];
  let toolCallCounter = 0;

  for (let i = 0; i < typedRow.trajectory.length; i += 1) {
    const entry = typedRow.trajectory[i];
    if (entry?.role !== "ai" || !entry.text) {
      continue;
    }

    const parsed = parseCommand(entry.text);
    if (!parsed) {
      continue;
    }

    const observationEntry = typedRow.trajectory[i + 1];
    const observation =
      observationEntry?.role === "user" && observationEntry.text
        ? observationEntry.text
        : "";

    toolCallCounter += 1;
    const toolCallId = `swe-${toolCallCounter}`;
    turns.push({
      observation,
      toolResult: makeToolResultEvent(toolCallId, parsed, observation),
    });
  }

  if (turns.length === 0) {
    return;
  }

  return {
    metadata: {
      exit_status: typedRow.exit_status,
      instance_id: typedRow.instance_id,
      model_name: typedRow.model_name,
      target: typedRow.target,
    },
    source: "swe-agent-trajectories",
    turns,
  };
}
