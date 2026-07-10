import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ParsedTrace, ParsedTurn } from "./types";

interface ToolathlonMessage {
  content?: string | null;
  role: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    function: {
      arguments: string;
      name: string;
    };
    id: string;
    type: string;
  }>;
}

interface ToolathlonRecord {
  messages: string;
  task_name?: string;
}

type SupportedToolName = "bash" | "find" | "grep" | "ls" | "read";

interface ParsedToolathlonCall {
  args: Record<string, unknown>;
  observation: string;
  toolName: SupportedToolName;
}

function extractToolText(content: string | null | undefined): string {
  if (!content) {
    return "";
  }

  if (typeof content !== "string") {
    return "";
  }

  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? "";
  } catch {
    return content;
  }
}

function buildParameterKey(
  toolName: string,
  rawArgs: Record<string, unknown>
): string {
  return `${toolName}:${JSON.stringify(rawArgs)}`;
}

function parseReadArgs(rawArgs: Record<string, unknown>): {
  args: Record<string, unknown>;
  toolName: "read";
} {
  const args: Record<string, unknown> = {};
  if (typeof rawArgs.path === "string") {
    args.path = rawArgs.path;
  }
  if (typeof rawArgs.head === "number") {
    args.limit = rawArgs.head;
    args.offset = 1;
  }
  if (typeof rawArgs.tail === "number") {
    // Tail reads are hard to map to a stable line-range archive key, so we
    // represent them as a read of the whole file. The trimmer will still
    // archive the returned content.
    args.path = rawArgs.path;
  }
  return { args, toolName: "read" };
}

function parseListDirArgs(rawArgs: Record<string, unknown>): {
  args: Record<string, unknown>;
  toolName: "ls";
} {
  return {
    args: { path: typeof rawArgs.path === "string" ? rawArgs.path : "." },
    toolName: "ls",
  };
}

function parseBashArgs(rawArgs: Record<string, unknown>):
  | {
      args: Record<string, unknown>;
      toolName: "bash";
    }
  | undefined {
  const { command, cmd } = rawArgs;
  let commandValue: string | undefined;
  if (typeof command === "string") {
    commandValue = command;
  } else if (typeof cmd === "string") {
    commandValue = cmd;
  }
  if (!commandValue) {
    return;
  }
  return { args: { command: commandValue }, toolName: "bash" };
}

function parsePythonExecuteArgs(rawArgs: Record<string, unknown>):
  | {
      args: Record<string, unknown>;
      toolName: "bash";
    }
  | undefined {
  const { code, script } = rawArgs;
  let codeValue: string | undefined;
  if (typeof code === "string") {
    codeValue = code;
  } else if (typeof script === "string") {
    codeValue = script;
  }
  if (!codeValue) {
    return;
  }
  return {
    args: { command: `python:${codeValue.slice(0, 200)}` },
    toolName: "bash",
  };
}

function parseGenericToolArgs(
  toolName: string,
  rawArgs: Record<string, unknown>
): {
  args: Record<string, unknown>;
  toolName: "bash";
} {
  return {
    args: { command: buildParameterKey(toolName, rawArgs) },
    toolName: "bash",
  };
}

type ToolArgsParser = (
  rawArgs: Record<string, unknown>
) => { args: Record<string, unknown>; toolName: SupportedToolName } | undefined;

const TOOL_PARSER_BY_NAME: Record<string, ToolArgsParser> = {
  bash: parseBashArgs,
  "filesystem-list_dir": parseListDirArgs,
  "filesystem-read_file": parseReadArgs,
  python_execute: parsePythonExecuteArgs,
};

function parseFunctionCall(
  name: string,
  rawArgs: Record<string, unknown>
): ParsedToolathlonCall {
  const parser =
    TOOL_PARSER_BY_NAME[name] ?? (() => parseGenericToolArgs(name, rawArgs));
  const result = parser(rawArgs);

  return {
    args: result.args,
    observation: "",
    toolName: result.toolName,
  };
}

function isValidToolathlonRecord(row: unknown): row is ToolathlonRecord {
  if (typeof row !== "object" || row === null) {
    return false;
  }
  return typeof (row as Record<string, unknown>).messages === "string";
}

function makeToolResultEvent(
  toolCallId: string,
  parsed: ParsedToolathlonCall
): ToolResultEvent {
  return {
    content: [{ text: parsed.observation, type: "text" as const }],
    details: undefined,
    input: parsed.args,
    isError: false,
    toolCallId,
    toolName: parsed.toolName,
    type: "tool_result" as const,
  };
}

function parseAssistantMessage(
  message: ToolathlonMessage
): Array<{ callId: string; parsed: ParsedToolathlonCall }> {
  const pending: Array<{ callId: string; parsed: ParsedToolathlonCall }> = [];

  for (const toolCall of message.tool_calls ?? []) {
    let rawArgs: Record<string, unknown>;
    try {
      rawArgs = JSON.parse(toolCall.function.arguments) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    pending.push({
      callId: toolCall.id,
      parsed: parseFunctionCall(toolCall.function.name, rawArgs),
    });
  }

  return pending;
}

function processToolMessage(
  message: ToolathlonMessage,
  pendingToolCalls: Array<{ callId: string; parsed: ParsedToolathlonCall }>,
  toolCallCounter: number
): { turns: ParsedTurn[]; updatedCounter: number } {
  const observation = extractToolText(message.content);
  const idx = pendingToolCalls.findIndex(
    (p) => p.callId === message.tool_call_id
  );
  if (idx === -1) {
    return { turns: [], updatedCounter: toolCallCounter };
  }

  const [{ parsed }] = pendingToolCalls.splice(idx, 1);
  parsed.observation = observation;

  const nextCounter = toolCallCounter + 1;
  const toolCallId = `toolathlon-${nextCounter}`;
  return {
    turns: [
      {
        observation,
        toolResult: makeToolResultEvent(toolCallId, parsed),
      },
    ],
    updatedCounter: nextCounter,
  };
}

export function adaptToolathlonTrace(row: unknown): ParsedTrace | undefined {
  if (!isValidToolathlonRecord(row)) {
    return;
  }

  let messages: ToolathlonMessage[];
  try {
    messages = JSON.parse(row.messages) as ToolathlonMessage[];
    if (!Array.isArray(messages)) {
      return;
    }
  } catch {
    return;
  }

  const turns: ParsedTurn[] = [];
  const pendingToolCalls: Array<{
    callId: string;
    parsed: ParsedToolathlonCall;
  }> = [];
  let toolCallCounter = 0;

  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls) {
      pendingToolCalls.push(...parseAssistantMessage(message));
      continue;
    }

    if (message.role === "tool") {
      const { turns: newTurns, updatedCounter } = processToolMessage(
        message,
        pendingToolCalls,
        toolCallCounter
      );
      turns.push(...newTurns);
      toolCallCounter = updatedCounter;
    }
  }

  if (turns.length === 0) {
    return;
  }

  return {
    metadata: {
      task_name: row.task_name,
    },
    source: "toolathlon-trajectories",
    turns,
  };
}
