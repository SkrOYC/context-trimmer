import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ArchivedResult } from "./types";

export function getHash(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

function joinTextParts(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

// AgentMessage is a union that spans plain LLM messages (user/assistant/toolResult)
// and pi's own custom message roles (bashExecution, custom, branchSummary,
// compactionSummary). Each role stores its text under a different field, and
// "user"/"custom" content can be a plain string instead of a content-part array,
// so there is no single `.content` shape to rely on across the whole union.
export function getMessageText(message: AgentMessage): string {
  if (message.role === "user" || message.role === "custom") {
    const { content } = message;
    return typeof content === "string" ? content : joinTextParts(content);
  }
  if (message.role === "assistant" || message.role === "toolResult") {
    return joinTextParts(message.content);
  }
  if (message.role === "bashExecution") {
    return message.output;
  }
  if (
    message.role === "branchSummary" ||
    message.role === "compactionSummary"
  ) {
    return message.summary;
  }
  return "";
}

// Footer patterns added by pi's read tool when more content exists beyond what was returned.
const READ_FOOTER_PATTERNS = [
  /^\[\d+ more lines in file\. Use offset=\d+ to continue\.]$/,
  /^\[Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.]$/,
  /^\[Showing lines \d+-\d+ of \d+ \(\d+(?:\.\d+)?[KMGT]?B limit\)\. Use offset=\d+ to continue\.]$/,
  /^\[Line \d+ is [\d.]+[KMGT]?B, exceeds \d+(?:\.\d+)?[KMGT]?B limit\. Use bash: .*]$/,
];

export function stripReadFooters(text: string): string {
  const parts = text.split("\n\n");
  if (parts.length === 0) {
    return text;
  }
  const last = parts.at(-1);
  if (last && READ_FOOTER_PATTERNS.some((pattern) => pattern.test(last))) {
    return parts.slice(0, -1).join("\n\n");
  }
  return text;
}

export function mergeIntervals(
  intervals: Array<{ start: number; end: number }>
): Array<{ start: number; end: number }> {
  const sorted = intervals
    .filter((i) => i.start <= i.end)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  const [first] = sorted;
  if (!first) {
    return merged;
  }
  let current = first;

  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    if (!next) {
      continue;
    }
    if (next.start <= current.end + 1) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = next;
    }
  }
  merged.push(current);
  return merged;
}

export function totalIntervalLength(
  intervals: Array<{ start: number; end: number }>
): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start + 1), 0);
}

function isFileBacked(arc: ArchivedResult): boolean {
  return arc.stalenessStrategy !== "immutable";
}

function groupFileBackedArchives(archives: ArchivedResult[]): {
  byPath: Map<string, ArchivedResult[]>;
  immutable: Map<string, boolean>;
} {
  const immutable = new Map<string, boolean>();
  const byPath = new Map<string, ArchivedResult[]>();

  for (const arc of archives) {
    if (isFileBacked(arc)) {
      const list = byPath.get(arc.parameterKey) ?? [];
      list.push(arc);
      byPath.set(arc.parameterKey, list);
    } else {
      immutable.set(arc.pointerId, true);
    }
  }

  return { byPath, immutable };
}

function checkArchiveAgainstLines(
  arc: ArchivedResult,
  diskLines: string[]
): boolean {
  const { lineHashes, startLine } = arc;

  for (let i = 0; i < lineHashes.length; i += 1) {
    const lineIndex = startLine - 1 + i;
    const diskLine = diskLines[lineIndex];
    if (diskLine === undefined || getHash(diskLine) !== lineHashes[i]) {
      return true;
    }
  }

  return false;
}

function checkPathArchives(
  paramKey: string,
  pathArchives: ArchivedResult[],
  cwd: string,
  result: Map<string, boolean>
): void {
  const filePath = isAbsolute(paramKey) ? paramKey : resolve(cwd, paramKey);

  if (!existsSync(filePath)) {
    for (const arc of pathArchives) {
      result.set(arc.pointerId, true);
    }
    return;
  }

  // readFileSync throws if the path is a directory (EISDIR) or unreadable
  // (EACCES). Left unguarded this rejects the whole batch and aborts the entire
  // eviction pass for the turn. Match single-archive checkStaleness: treat any
  // read failure as "stale" for every archive on this path.
  let diskLines: string[];
  try {
    diskLines = readFileSync(filePath, "utf8").split("\n");
  } catch {
    for (const arc of pathArchives) {
      result.set(arc.pointerId, true);
    }
    return;
  }

  for (const arc of pathArchives) {
    result.set(arc.pointerId, checkArchiveAgainstLines(arc, diskLines));
  }
}

export function checkStalenessBatch(
  archives: ArchivedResult[],
  cwd: string
): Map<string, boolean> {
  const { byPath, immutable } = groupFileBackedArchives(archives);
  const result = new Map(immutable);

  for (const [paramKey, pathArchives] of byPath) {
    checkPathArchives(paramKey, pathArchives, cwd, result);
  }

  return result;
}

export function checkStaleness(arc: ArchivedResult, cwd: string): boolean {
  if (!isFileBacked(arc)) {
    return true;
  }

  try {
    const filePath = isAbsolute(arc.parameterKey)
      ? arc.parameterKey
      : resolve(cwd, arc.parameterKey);

    if (!existsSync(filePath)) {
      return true;
    }

    const diskContent = readFileSync(filePath, "utf8");
    // Match pi's read tool, which splits on "\n" and preserves "\r" on Windows lines.
    const diskLines = diskContent.split("\n");

    const { lineHashes, startLine } = arc;

    for (let i = 0; i < lineHashes.length; i += 1) {
      const lineIndex = startLine - 1 + i;
      const diskLine = diskLines[lineIndex];
      if (diskLine === undefined) {
        return true;
      }
      if (getHash(diskLine) !== lineHashes[i]) {
        return true;
      }
    }

    return false;
  } catch {
    return true; // Fallback to stale on read failure
  }
}
