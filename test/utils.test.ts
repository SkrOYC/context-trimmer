import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArchivedResult } from "../src/types";
import {
  checkStaleness,
  checkStalenessBatch,
  getHash,
  mergeIntervals,
  stripReadFooters,
  totalIntervalLength,
} from "../src/utils";

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
      const text =
        "Line 1\nLine 2\n\n[3 more lines in file. Use offset=3 to continue.]";
      expect(stripReadFooters(text)).toBe("Line 1\nLine 2");
    });

    it("removes the range-based continuation footer", () => {
      const text =
        "Line 5\nLine 6\n\n[Showing lines 5-6 of 10. Use offset=7 to continue.]";
      expect(stripReadFooters(text)).toBe("Line 5\nLine 6");
    });

    it("removes the byte-limit range footer", () => {
      const text =
        "Line 1\n\n[Showing lines 1-1 of 5 (50KB limit). Use offset=2 to continue.]";
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
      expect(mergeIntervals([{ end: 10, start: 5 }])).toEqual([
        { end: 10, start: 5 },
      ]);
    });

    it("merges overlapping intervals", () => {
      const intervals = [
        { end: 5, start: 1 },
        { end: 7, start: 3 },
        { end: 10, start: 8 },
      ];
      expect(mergeIntervals(intervals)).toEqual([{ end: 10, start: 1 }]);
    });

    it("merges adjacent intervals", () => {
      const intervals = [
        { end: 5, start: 1 },
        { end: 10, start: 6 },
      ];
      expect(mergeIntervals(intervals)).toEqual([{ end: 10, start: 1 }]);
    });

    it("keeps disjoint intervals separate", () => {
      const intervals = [
        { end: 3, start: 1 },
        { end: 7, start: 5 },
      ];
      expect(mergeIntervals(intervals)).toEqual([
        { end: 3, start: 1 },
        { end: 7, start: 5 },
      ]);
    });

    it("sorts unsorted intervals", () => {
      const intervals = [
        { end: 12, start: 10 },
        { end: 3, start: 1 },
        { end: 8, start: 5 },
      ];
      expect(mergeIntervals(intervals)).toEqual([
        { end: 3, start: 1 },
        { end: 8, start: 5 },
        { end: 12, start: 10 },
      ]);
    });

    it("discards invalid intervals where start > end", () => {
      expect(mergeIntervals([{ end: 3, start: 5 }])).toEqual([]);
    });
  });

  describe("totalIntervalLength", () => {
    it("sums interval lengths", () => {
      expect(
        totalIntervalLength([
          { end: 3, start: 1 },
          { end: 5, start: 5 },
        ])
      ).toBe(4);
    });

    it("returns 0 for an empty array", () => {
      expect(totalIntervalLength([])).toBe(0);
    });
  });

  describe("checkStaleness", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "pi-trimmer-utils-"));
    });

    afterEach(() => {
      rmSync(tempDir, { force: true, recursive: true });
    });

    function makeArc(
      paramKey: string,
      startLine: number,
      lines: string[]
    ): ArchivedResult {
      return {
        lineHashes: lines.map(getHash),
        originalContent: JSON.stringify([
          { text: lines.join("\n"), type: "text" },
        ]),
        parameterKey: paramKey,
        pointerId: "ptr_test",
        startLine,
        timestamp: Date.now(),
        toolCallId: "call-test",
        toolName: "read",
      };
    }

    it("returns false when the file matches", () => {
      const filePath = join(tempDir, "file.txt");
      const lines = ["Line 1", "Line 2", "Line 3"];
      writeFileSync(filePath, lines.join("\n"), "utf8");

      const arc = makeArc(filePath, 1, lines);
      expect(checkStaleness(arc, tempDir)).toBe(false);
    });

    it("returns true when a line changed", () => {
      const filePath = join(tempDir, "file.txt");
      writeFileSync(filePath, "Line 1\nchanged\nLine 3", "utf8");

      const arc = makeArc(filePath, 1, ["Line 1", "Line 2", "Line 3"]);
      expect(checkStaleness(arc, tempDir)).toBe(true);
    });

    it("returns true when a read line is beyond the current file length", () => {
      const filePath = join(tempDir, "file.txt");
      writeFileSync(filePath, "Line 1", "utf8");

      const arc = makeArc(filePath, 1, ["Line 1", "Line 2"]);
      expect(checkStaleness(arc, tempDir)).toBe(true);
    });

    it("returns true when the file was deleted", () => {
      const filePath = join(tempDir, "file.txt");
      writeFileSync(filePath, "Line 1", "utf8");

      const arc = makeArc(filePath, 1, ["Line 1"]);
      unlinkSync(filePath);

      expect(checkStaleness(arc, tempDir)).toBe(true);
    });

    it("resolves relative paths against cwd", () => {
      const fileName = "relative.txt";
      writeFileSync(join(tempDir, fileName), "Line 1\nLine 2", "utf8");

      const arc = makeArc(fileName, 1, ["Line 1", "Line 2"]);
      expect(checkStaleness(arc, tempDir)).toBe(false);
    });

    it("returns true on read failure", () => {
      const filePath = join(tempDir, "unreadable");
      writeFileSync(filePath, "secret", { mode: 0o000 });

      try {
        const arc = makeArc(filePath, 1, ["secret"]);
        expect(checkStaleness(arc, tempDir)).toBe(true);
      } finally {
        chmodSync(filePath, 0o644);
      }
    });
  });

  describe("checkStalenessBatch", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "pi-trimmer-batch-"));
    });

    afterEach(() => {
      rmSync(tempDir, { force: true, recursive: true });
    });

    function makeArc(
      pointerId: string,
      paramKey: string,
      startLine: number,
      lines: string[]
    ): ArchivedResult {
      return {
        lineHashes: lines.map(getHash),
        originalContent: JSON.stringify([
          { text: lines.join("\n"), type: "text" },
        ]),
        parameterKey: paramKey,
        pointerId,
        startLine,
        timestamp: Date.now(),
        toolCallId: pointerId,
        toolName: "read",
      };
    }

    it("checks multiple archives of the same file in one read", () => {
      const filePath = join(tempDir, "file.txt");
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`);
      writeFileSync(filePath, lines.join("\n"), "utf8");

      const arc1 = makeArc("ptr-1", filePath, 1, lines.slice(0, 5));
      const arc2 = makeArc("ptr-2", filePath, 6, lines.slice(5, 10));

      const result = checkStalenessBatch([arc1, arc2], tempDir);
      expect(result.get("ptr-1")).toBe(false);
      expect(result.get("ptr-2")).toBe(false);
    });

    it("marks all archives of a deleted file as stale", () => {
      const filePath = join(tempDir, "file.txt");
      const lines = ["Line 1", "Line 2"];
      writeFileSync(filePath, lines.join("\n"), "utf8");

      const arc1 = makeArc("ptr-1", filePath, 1, ["Line 1"]);
      const arc2 = makeArc("ptr-2", filePath, 2, ["Line 2"]);

      unlinkSync(filePath);

      const result = checkStalenessBatch([arc1, arc2], tempDir);
      expect(result.get("ptr-1")).toBe(true);
      expect(result.get("ptr-2")).toBe(true);
    });

    it("detects a stale archive whose range extends beyond the file", () => {
      const filePath = join(tempDir, "file.txt");
      writeFileSync(filePath, "Line 1", "utf8");

      const arc = makeArc("ptr-1", filePath, 1, ["Line 1", "Line 2"]);

      const result = checkStalenessBatch([arc], tempDir);
      expect(result.get("ptr-1")).toBe(true);
    });

    it("returns an empty map for an empty archive list", () => {
      expect(checkStalenessBatch([], tempDir).size).toBe(0);
    });
  });
});
