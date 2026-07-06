export const ARCHIVE_TYPE = "results-archive";

export interface ArchivedResult {
  pointerId: string;
  toolName: string;
  toolCallId: string;
  parameterKey: string;      // Resolved absolute or relative file path
  timestamp: number;
  originalContent: string;   // JSON-serialized tool result content
  startLine: number;         // 1-indexed starting line
  lineHashes: string[];      // SHA-256 hashes of each read line
}

export interface ToolPolicy {
  toolName: string;
  getParameterKey: (input: Record<string, any>) => string | undefined;
}

export interface LineRange {
  start: number; // 1-indexed, inclusive
  end: number;   // 1-indexed, inclusive
}

export interface EvictionCandidate {
  archive: ArchivedResult;
  score: number;
}

export const POLICIES: ToolPolicy[] = [
  {
    toolName: "read",
    getParameterKey: (input) => input.path,
  }
];
