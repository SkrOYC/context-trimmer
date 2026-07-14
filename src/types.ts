import type {
  ToolResultEvent,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { stripReadFooters } from "./utils";

export const ARCHIVE_TYPE = "results-archive";

export type StalenessStrategy = "file-lines" | "immutable";
export type SupersessionStrategy = "exact-key" | "line-range" | "none";

export interface ArchivedResult {
  lineHashes: string[]; // SHA-256 hashes of each archived line
  originalContent: string; // JSON-serialized tool result content
  parameterKey: string; // Resolved identifier for the tool invocation
  pointerId: string;
  stalenessStrategy?: StalenessStrategy; // Defaults to "file-lines" for backward compatibility
  startLine: number; // 1-indexed starting line
  supersessionStrategy?: SupersessionStrategy; // Defaults to "line-range" for backward compatibility
  timestamp: number;
  toolCallId: string;
  toolName: string;
}

export interface ToolPolicy {
  extractContent: (event: ToolResultEvent) => string | undefined;
  getParameterKey: (input: Record<string, unknown>) => string | undefined;
  stalenessStrategy: StalenessStrategy;
  supersessionStrategy: SupersessionStrategy;
  toolName: string;
}

export interface LineRange {
  end: number; // 1-indexed, inclusive
  start: number; // 1-indexed, inclusive
}

export interface EvictionCandidate {
  archive: ArchivedResult;
  score: number;
}

export function getArchiveGroupKey(
  toolName: string,
  parameterKey: string
): string {
  return `${toolName}:${parameterKey}`;
}

function getReadParameterKey(
  input: Record<string, unknown>
): string | undefined {
  return typeof input.path === "string" ? input.path : undefined;
}

function getBashParameterKey(
  input: Record<string, unknown>
): string | undefined {
  return typeof input.command === "string" ? input.command : undefined;
}

function getGrepParameterKey(
  input: Record<string, unknown>
): string | undefined {
  if (typeof input.pattern !== "string") {
    return;
  }

  const parts = [input.pattern];
  if (typeof input.path === "string") {
    parts.push(`path=${input.path}`);
  }
  if (typeof input.glob === "string") {
    parts.push(`glob=${input.glob}`);
  }
  if (input.ignoreCase === true) {
    parts.push("ignoreCase");
  }
  if (input.literal === true) {
    parts.push("literal");
  }
  if (typeof input.context === "number") {
    parts.push(`context=${input.context}`);
  }

  return parts.join("|");
}

function getFindParameterKey(
  input: Record<string, unknown>
): string | undefined {
  if (typeof input.pattern !== "string") {
    return;
  }

  const parts = [input.pattern];
  if (typeof input.path === "string") {
    parts.push(`path=${input.path}`);
  }

  return parts.join("|");
}

function getLsParameterKey(input: Record<string, unknown>): string | undefined {
  return typeof input.path === "string" ? input.path : ".";
}

function joinTextContent(event: ToolResultEvent): string {
  return event.content
    .map((content) => (content.type === "text" ? content.text || "" : ""))
    .join("\n");
}

// The tools we archive (bash/grep/find/ls/read) all shape `details` as
// `{ truncation?: TruncationResult }`, but ToolResultEvent is a union whose other
// members (edit/write/custom) declare unrelated `details` types, so TypeScript
// can't resolve `.truncation` on the union directly.
function getTruncation(event: ToolResultEvent): TruncationResult | undefined {
  return (event.details as { truncation?: TruncationResult } | undefined)
    ?.truncation;
}

function extractGenericContent(event: ToolResultEvent): string | undefined {
  const truncation = getTruncation(event);
  if (truncation) {
    if (truncation.firstLineExceedsLimit) {
      return;
    }
    return truncation.content;
  }

  return joinTextContent(event);
}

function extractReadContent(event: ToolResultEvent): string | undefined {
  const truncation = getTruncation(event);
  if (truncation) {
    if (truncation.firstLineExceedsLimit) {
      return;
    }
    return truncation.content;
  }

  return stripReadFooters(joinTextContent(event));
}

export const POLICIES: ToolPolicy[] = [
  {
    extractContent: extractReadContent,
    getParameterKey: getReadParameterKey,
    stalenessStrategy: "file-lines",
    supersessionStrategy: "line-range",
    toolName: "read",
  },
  {
    extractContent: extractGenericContent,
    getParameterKey: getBashParameterKey,
    stalenessStrategy: "immutable",
    supersessionStrategy: "exact-key",
    toolName: "bash",
  },
  {
    extractContent: extractGenericContent,
    getParameterKey: getGrepParameterKey,
    stalenessStrategy: "immutable",
    supersessionStrategy: "exact-key",
    toolName: "grep",
  },
  {
    extractContent: extractGenericContent,
    getParameterKey: getFindParameterKey,
    stalenessStrategy: "immutable",
    supersessionStrategy: "exact-key",
    toolName: "find",
  },
  {
    extractContent: extractGenericContent,
    getParameterKey: getLsParameterKey,
    stalenessStrategy: "immutable",
    supersessionStrategy: "exact-key",
    toolName: "ls",
  },
];
