export const ARCHIVE_TYPE = "results-archive";

export interface ArchivedResult {
  lineHashes: string[]; // SHA-256 hashes of each read line
  originalContent: string; // JSON-serialized tool result content
  parameterKey: string; // Resolved absolute or relative file path
  pointerId: string;
  startLine: number; // 1-indexed starting line
  timestamp: number;
  toolCallId: string;
  toolName: string;
}

export interface ToolPolicy {
  getParameterKey: (input: Record<string, unknown>) => string | undefined;
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

export const POLICIES: ToolPolicy[] = [
  {
    getParameterKey: (input) =>
      typeof input.path === "string" ? input.path : undefined,
    toolName: "read",
  },
];
