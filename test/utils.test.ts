import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getHash,
  stripReadFooters,
  mergeIntervals,
  totalIntervalLength,
  checkStaleness,
  checkStalenessBatch,
} from "../src/utils";
import type { ArchivedResult } from "../src/types";

describe("Utils", () => {
  describe("getHash", () => {
    it("returns consistent SHA-256 hashes", () => {
      const h1 = getHash("hello");
      const h2 = getHash("hello");
      const h3 = getHash("world");
      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1).toHaveLength(64);
    });
  });

  describe("stripReadFooters", () => {
    it("removes the standard continuation footer", () => {
      const text = "Line 1\nLine 2\n\n[3 more lines in file. Use offset=3 to continue.]";
      expect(stripReadFooters(text)).toBe("Line 1\nLine 2");
    });

    it("removes the range-based continuation footer", () => {
      const text = "Line 5\nLine 6\n\n[Showing lines 5-6 of 10. Use offset=7 to continue.]";
      expect(stripReadFooters(text)).toBe("Line 5\nLine 6");
    });

    it("removes the byte-limit range footer", () => {
      const text = "Line 1\n\n[Showing lines 1-1 of 5 (50KB limit). Use offset=2 to continue.]";
      expect(stripReadFooters(text)).toBe("Line 1");
    });

    it("removes the oversized-line footer", () => {
      const text = "[Line 1 is 60KB, exceeds 50KB limit. Use bash: ...]";
      expect(stripReadFooters(text)).toBe("");
    });

    it("returns text unchanged when there is no footer", () => {
      const text = "Line 1\nLine 2";
      expect(stripReadFooters(text)).toBe(text);
    });

    it("returns empty string for empty input", () => {
      expect(stripReadFooters("")).toBe("");
    });
  });

  describe("mergeIntervals", () => {
    it("returns an empty array for no intervals", () => {
      expect(mergeIntervals([])).toEqual([]);
    });

    it("returns a single interval unchanged", () => {
      expect(mergeIntervals([{ start: 5, end: 10 }])).toEqual([{ start: 5, end: 10 }]);
    });

    it("merges overlapping intervals", () => {
      const intervals = [
        { start: 1, end: 5 },
        { start: 3, end: 7 },
        { start: 8, end: 10 },
      ];
      expect(mergeIntervals(intervals)).toEqual([{ start: 1, end: 10 }]);
    });

    it("merges adjacent intervals", () => {
      const intervals = [
        { start: 1, end: 5 },
        { start: 6, end: 10 },
      ];
      expect(mergeIntervals(intervals)).toEqual([{ start: 1, end: 10 }]);
    });

    it("keeps disjoint intervals separate", () => {
      const intervals = [
        { start: 1, end: 3 },
        { start: 5, end: 7 },
      ];
      expect(mergeIntervals(intervals)).toEqual([
        { start: 1, end: 3 },
        { start: 5, end: 7 },
      ]);
    });

    it("sorts unsorted intervals", () => {
      const intervals = [
        { start: 10, end: 12 },
        { start: 1, end: 3 },
        { start: 5, end: 8 },
      ];
      expect(mergeIntervals(intervals)).toEqual([
        { start: 1, end: 3 },
        { start: 5, end: 8 },
        { start: 10, end: 12 },
      ]);
    });

    it("discards invalid intervals where start > end", () => {
      expect(mergeIntervals([{ start: 5, end: 3 }])).toEqual([]);
    });
  });

  describe("totalIntervalLength", () => {
    it("sums interval lengths", () => {
      expect(totalIntervalLength([{ start: 1, end: 3 }, { start: 5, end: 5 }])).toBe(4);
    });

    it("returns 0 for an empty array", () => {
      expect(totalIntervalLength([])).toBe(0);
    });
  });

  describe("checkStaleness", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trimmer-utils-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function makeArc(paramKey: string, startLine: number, lines: string[]): ArchivedResult {
      return {
        pointerId: "ptr_test",
        toolName: "read",
        toolCallId: "call-test",
        parameterKey: paramKey,
        timestamp: Date.now(),
        originalContent: JSON.stringify([{ type: "text", text: lines.join("\n") }]),
        startLine,
        lineHashes: lines.map(getHash),
      };
    }

    it("returns false when the file matches", () => {
      const filePath = path.join(tempDir, "file.txt");
      const lines = ["Line 1", "Line 2", "Line 3"];
      fs.writeFileSync(filePath, lines.join("\n"), "utf8");

      const arc = makeArc(filePath, 1, lines);
      expect(checkStaleness(arc, tempDir)).toBe(false);
    });

    it("returns true when a line changed", () => {
      const filePath = path.join(tempDir, "file.txt");
      fs.writeFileSync(filePath, "Line 1\nchanged\nLine 3", "utf8");

      const arc = makeArc(filePath, 1, ["Line 1", "Line 2", "Line 3"]);
      expect(checkStaleness(arc, tempDir)).toBe(true);
    });

    it("returns true when a read line is beyond the current file length", () => {
      const filePath = path.join(tempDir, "file.txt");
      fs.writeFileSync(filePath, "Line 1", "utf8");

      const arc = makeArc(filePath, 1, ["Line 1", "Line 2"]);
      expect(checkStaleness(arc, tempDir)).toBe(true);
    });

    it("returns true when the file was deleted", () => {
      const filePath = path.join(tempDir, "file.txt");
      fs.writeFileSync(filePath, "Line 1", "utf8");

      const arc = makeArc(filePath, 1, ["Line 1"]);
      fs.unlinkSync(filePath);

      expect(checkStaleness(arc, tempDir)).toBe(true);
    });

    it("resolves relative paths against cwd", () => {
      const fileName = "relative.txt";
      fs.writeFileSync(path.join(tempDir, fileName), "Line 1\nLine 2", "utf8");

      const arc = makeArc(fileName, 1, ["Line 1", "Line 2"]);
      expect(checkStaleness(arc, tempDir)).toBe(false);
    });

    it("returns true on read failure", () => {
      const filePath = path.join(tempDir, "unreadable");
      fs.writeFileSync(filePath, "secret", { mode: 0o000 });

      try {
        const arc = makeArc(filePath, 1, ["secret"]);
        expect(checkStaleness(arc, tempDir)).toBe(true);
      } finally {
        fs.chmodSync(filePath, 0o644);
      }
    });
  });

  describe("checkStalenessBatch", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trimmer-batch-"));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function makeArc(pointerId: string, paramKey: string, startLine: number, lines: string[]): ArchivedResult {
      return {
        pointerId,
        toolName: "read",
        toolCallId: pointerId,
        parameterKey: paramKey,
        timestamp: Date.now(),
        originalContent: JSON.stringify([{ type: "text", text: lines.join("\n") }]),
        startLine,
        lineHashes: lines.map(getHash),
      };
    }

    it("checks multiple archives of the same file in one read", () => {
      const filePath = path.join(tempDir, "file.txt");
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      fs.writeFileSync(filePath, lines.join("\n"), "utf8");

      const arc1 = makeArc("ptr-1", filePath, 1, lines.slice(0, 5));
      const arc2 = makeArc("ptr-2", filePath, 6, lines.slice(5, 10));

      const result = checkStalenessBatch([arc1, arc2], tempDir);
      expect(result.get("ptr-1")).toBe(false);
      expect(result.get("ptr-2")).toBe(false);
    });

    it("marks all archives of a deleted file as stale", () => {
      const filePath = path.join(tempDir, "file.txt");
      const lines = ["Line 1", "Line 2"];
      fs.writeFileSync(filePath, lines.join("\n"), "utf8");

      const arc1 = makeArc("ptr-1", filePath, 1, ["Line 1"]);
      const arc2 = makeArc("ptr-2", filePath, 2, ["Line 2"]);

      fs.unlinkSync(filePath);

      const result = checkStalenessBatch([arc1, arc2], tempDir);
      expect(result.get("ptr-1")).toBe(true);
      expect(result.get("ptr-2")).toBe(true);
    });

    it("detects a stale archive whose range extends beyond the file", () => {
      const filePath = path.join(tempDir, "file.txt");
      fs.writeFileSync(filePath, "Line 1", "utf8");

      const arc = makeArc("ptr-1", filePath, 1, ["Line 1", "Line 2"]);

      const result = checkStalenessBatch([arc], tempDir);
      expect(result.get("ptr-1")).toBe(true);
    });

    it("returns an empty map for an empty archive list", () => {
      expect(checkStalenessBatch([], tempDir).size).toBe(0);
    });
  });
});
