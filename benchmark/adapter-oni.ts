import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ParsedTrace, ParsedTurn } from "./types";

interface OniTrace {
  messages?: Array<{
    content?: string;
    role?: string;
  }>;
  meta?: Record<string, unknown>;
}

type SupportedToolName = "bash" | "find" | "grep" | "ls" | "read";

interface ParsedOniCall {
  args: Record<string, unknown>;
  toolName: SupportedToolName;
}

const CODE_BLOCK_REGEX = /<code>([\s\S]*?)<\/code>/;
const CALL_SIGNATURE_REGEX = /^(?:\w+\s*=\s*)?(\w+)\s*\((.*)\)\s*;?\s*$/s;

function extractKwarg(text: string, key: string): string | undefined {
  const marker = `${key}=`;
  const start = text.indexOf(marker);
  if (start === -1) {
    return;
  }

  let valueStart = start + marker.length;
  const quote = text[valueStart];

  if (quote === '"' || quote === "'") {
    valueStart += 1;
    const end = text.indexOf(quote, valueStart);
    if (end === -1) {
      return text.slice(valueStart);
    }
    return text.slice(valueStart, end);
  }

  const end = text.indexOf(",", valueStart);
  if (end === -1) {
    return text.slice(valueStart).trim();
  }
  return text.slice(valueStart, end).trim();
}

function parseBashCall(argText: string): ParsedOniCall | undefined {
  const command = extractKwarg(argText, "command");
  if (!command) {
    return;
  }
  return { args: { command }, toolName: "bash" };
}

function parseReadFileCall(argText: string): ParsedOniCall | undefined {
  const path = extractKwarg(argText, "path");
  if (!path) {
    return;
  }

  const args: Record<string, unknown> = { path };
  const lines = extractKwarg(argText, "lines");
  if (lines) {
    const [start, end] = lines.split(":").map(Number);
    if (!Number.isNaN(start)) {
      args.offset = start;
    }
    if (!Number.isNaN(end)) {
      args.limit = end - start + 1;
    }
  }

  return { args, toolName: "read" };
}

function parseListDirCall(argText: string): ParsedOniCall | undefined {
  const path = extractKwarg(argText, "path");
  if (!path) {
    return;
  }
  return { args: { path }, toolName: "ls" };
}

function parseSingleCall(code: string): ParsedOniCall | undefined {
  const callMatch = code.match(CALL_SIGNATURE_REGEX);
  if (!callMatch) {
    return;
  }

  const [, toolName, argText = ""] = callMatch;

  if (toolName === "bash") {
    return parseBashCall(argText);
  }
  if (toolName === "read_file") {
    return parseReadFileCall(argText);
  }
  if (toolName === "list_dir") {
    return parseListDirCall(argText);
  }

  // write_file and any other tools are not archived by the trimmer.
}

function parseCodeBlock(content: string): ParsedOniCall[] {
  const codeMatch = content.match(CODE_BLOCK_REGEX);
  if (!codeMatch) {
    return [];
  }

  const code = codeMatch[1]?.trim() ?? "";
  if (code.length === 0) {
    return [];
  }

  const calls: ParsedOniCall[] = [];
  for (const line of code.split("\n")) {
    const call = parseSingleCall(line.trim());
    if (call) {
      calls.push(call);
    }
  }

  return calls;
}

function extractObservation(content: string): string {
  const marker = "Observation:";
  const idx = content.indexOf(marker);
  if (idx === -1) {
    return content;
  }
  return content.slice(idx + marker.length).trim();
}

function makeToolResultEvent(
  toolCallId: string,
  parsed: ParsedOniCall,
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

function isValidOniTrace(row: unknown): row is OniTrace {
  if (typeof row !== "object" || row === null) {
    return false;
  }
  const candidate = row as Record<string, unknown>;
  if (!Array.isArray(candidate.messages)) {
    return false;
  }
  return candidate.messages.every(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      typeof (message as Record<string, unknown>).role === "string"
  );
}

export function adaptOniTrace(row: unknown): ParsedTrace | undefined {
  if (!isValidOniTrace(row)) {
    return;
  }

  const turns: ParsedTurn[] = [];
  let toolCallCounter = 0;

  for (let i = 0; i < row.messages.length; i += 1) {
    const message = row.messages[i];
    if (message?.role !== "assistant" || !message.content) {
      continue;
    }

    const calls = parseCodeBlock(message.content);
    if (calls.length === 0) {
      continue;
    }

    const observationMessage = row.messages[i + 1];
    const observation =
      observationMessage?.role === "user" && observationMessage.content
        ? extractObservation(observationMessage.content)
        : "";

    for (const parsed of calls) {
      toolCallCounter += 1;
      const toolCallId = `oni-${toolCallCounter}`;
      turns.push({
        observation,
        toolResult: makeToolResultEvent(toolCallId, parsed, observation),
      });
    }
  }

  if (turns.length === 0) {
    return;
  }

  return {
    metadata: {
      ...row.meta,
    },
    source: "oni-devops-traces",
    turns,
  };
}
