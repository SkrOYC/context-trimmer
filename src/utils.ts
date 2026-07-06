import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ArchivedResult } from "./types";

export function getHash(str: string): string {
  return createHash("sha256").update(str).digest("hex");
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
  if (parts.length === 0) return text;
  const last = parts[parts.length - 1];
  if (READ_FOOTER_PATTERNS.some(pattern => pattern.test(last))) {
    return parts.slice(0, -1).join("\n\n");
  }
  return text;
}

export function checkStaleness(arc: ArchivedResult, cwd: string): boolean {
  try {
    const filePath = path.isAbsolute(arc.parameterKey)
      ? arc.parameterKey
      : path.resolve(cwd, arc.parameterKey);

    if (!fs.existsSync(filePath)) {
      return true;
    }

    const diskContent = fs.readFileSync(filePath, "utf8");
    // Match pi's read tool, which splits on "\n" and preserves "\r" on Windows lines.
    const diskLines = diskContent.split("\n");

    const startLine = arc.startLine;
    const lineHashes = arc.lineHashes;

    for (let i = 0; i < lineHashes.length; i++) {
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
