import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type ContextUsage,
  DEFAULT_EVICTION_CONFIG,
  type EvictionConfig,
  selectEvictionCandidates,
} from "../src/eviction";
import { createArchiveState } from "../src/state";
import type { ArchivedResult } from "../src/types";

// Unit tests for the pure eviction scorer. These exercise the eviction CONTRACT
// directly (dead-content bypass, pressure gate, batching, append-only,
// most-recent protection) with controlled inputs, rather than driving the whole
// extension with realistically-sized context. Integration behaviour (archiving,
// recall, staleness) lives in context-trimmer.test.ts.

const CWD = "/nonexistent-test-cwd";

function readArchive(
  id: string,
  path: string,
  startLine: number,
  lineCount: number
): ArchivedResult {
  return {
    lineHashes: Array.from(
      { length: lineCount },
      (_, i) => `h${startLine + i}`
    ),
    originalContent: "",
    parameterKey: path,
    pointerId: id,
    stalenessStrategy: "file-lines",
    startLine,
    supersessionStrategy: "line-range",
    timestamp: 0,
    toolCallId: id,
    toolName: "read",
  };
}

function bashArchive(id: string, command: string): ArchivedResult {
  return {
    lineHashes: ["h"],
    originalContent: "",
    parameterKey: command,
    pointerId: id,
    stalenessStrategy: "immutable",
    startLine: 1,
    supersessionStrategy: "exact-key",
    timestamp: 0,
    toolCallId: id,
    toolName: "bash",
  };
}

function stateFrom(archives: ArchivedResult[]) {
  const state = createArchiveState();
  for (const arc of archives) {
    state.registerArchive(arc);
  }
  return state;
}

/** One toolResult message per archive, in order, sized to `tokens` (~4 chars). */
function messagesFor(
  archives: ArchivedResult[],
  tokensByPointer: Record<string, number>
): AgentMessage[] {
  return archives.map((arc) => ({
    content: [
      {
        text: "x".repeat((tokensByPointer[arc.pointerId] ?? 1) * 4),
        type: "text" as const,
      },
    ],
    isError: false,
    role: "toolResult" as const,
    timestamp: 0,
    toolCallId: arc.toolCallId,
    toolName: arc.toolName,
  }));
}

function usage(contextWindow: number | null): ContextUsage {
  return { contextWindow, percent: null, tokens: null };
}

function cfg(overrides: Partial<EvictionConfig> = {}): EvictionConfig {
  return { ...DEFAULT_EVICTION_CONFIG, minBatchTokens: 1, ...overrides };
}

const HUGE_WINDOW = 1_000_000_000; // pressure is effectively zero

describe("selectEvictionCandidates", () => {
  it("evicts a fully superseded read even with no pressure (dead bypass)", () => {
    // Two identical reads of the same range: the newer fully supersedes the old.
    const old = readArchive("a", "/f", 1, 100);
    const fresh = readArchive("b", "/f", 1, 100);
    const state = stateFrom([old, fresh]);
    const msgs = messagesFor([old, fresh], { a: 100, b: 100 });

    const result = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(),
      cfg(),
      new Map([
        ["a", false],
        ["b", false],
      ])
    );

    // Old read is dead (superseded) -> evicted with no pressure; newest protected.
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(false);
  });

  it("evicts a proven-stale read even with no pressure (dead bypass)", () => {
    const stale = readArchive("a", "/f", 1, 100);
    const other = readArchive("b", "/g", 1, 100);
    const state = stateFrom([stale, other]);
    const msgs = messagesFor([stale, other], { a: 100, b: 100 });

    const result = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(),
      cfg(),
      new Map([
        ["a", true], // /f changed on disk: proven stale
        ["b", false],
      ])
    );

    expect(result.has("a")).toBe(true);
  });

  it("does NOT free-evict an assumed-stale immutable tool (only proven counts)", () => {
    // A bash result is only *assumed* immutable/stale; with no pressure it must
    // not be treated as provably dead.
    const oldBash = bashArchive("a", "git status");
    const other = bashArchive("b", "git log");
    const state = stateFrom([oldBash, other]);
    const msgs = messagesFor([oldBash, other], { a: 100, b: 100 });

    const result = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(),
      cfg(),
      new Map([
        ["a", true],
        ["b", true],
      ])
    );

    expect(result.size).toBe(0);
  });

  it("does NOT evict a partially superseded, still-valid read without pressure", () => {
    const old = readArchive("a", "/f", 1, 100);
    const partial = readArchive("b", "/f", 1, 30); // covers 30% of old
    const state = stateFrom([old, partial]);
    const msgs = messagesFor([old, partial], { a: 100, b: 30 });

    const result = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(),
      cfg(),
      new Map([
        ["a", false],
        ["b", false],
      ])
    );

    expect(result.size).toBe(0);
  });

  it("gates valid-content eviction on pressure (same read, window changes)", () => {
    const old = readArchive("a", "/f", 1, 100);
    const partial = readArchive("b", "/f", 1, 30);
    const state = stateFrom([old, partial]);
    const msgs = messagesFor([old, partial], { a: 100, b: 30 });
    // Low threshold so the only thing separating the two runs is the pressure gate.
    const config = cfg({ threshold: 0.01 });

    const noPressure = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(),
      config,
      new Map([["a", false]])
    );
    expect(noPressure.size).toBe(0);

    // Window ~= compiled size (130 tokens) so pressure is well above the knee.
    const underPressure = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(140),
      CWD,
      new Set(),
      config,
      new Map([["a", false]])
    );
    expect(underPressure.has("a")).toBe(true);
  });

  it("protects the most recently archived result even when it is dead", () => {
    const old = readArchive("a", "/f", 1, 100);
    const fresh = readArchive("b", "/f", 1, 100);
    const state = stateFrom([old, fresh]);
    const msgs = messagesFor([old, fresh], { a: 100, b: 100 });

    const result = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(),
      cfg(),
      // Both proven stale AND b supersedes a: b is dead too, but it is newest.
      new Map([
        ["a", true],
        ["b", true],
      ])
    );

    expect(result.has("b")).toBe(false);
  });

  it("batches: holds a small dead item until the batch is worth an invalidation", () => {
    const old = readArchive("a", "/f", 1, 100);
    const fresh = readArchive("b", "/f", 1, 100);
    const state = stateFrom([old, fresh]);
    // Old frees only ~100 tokens; batch requires 8000.
    const msgs = messagesFor([old, fresh], { a: 100, b: 100 });
    const config = cfg({ minBatchTokens: 8000 });

    const held = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(),
      config,
      new Map([["a", false]])
    );
    expect(held.size).toBe(0);

    // But when we are against the window, the overflow guard forces the flush.
    const forced = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(210),
      CWD,
      new Set(),
      config,
      new Map([["a", false]])
    );
    expect(forced.has("a")).toBe(true);
  });

  it("is append-only: previously evicted pointers are always retained", () => {
    const old = readArchive("a", "/f", 1, 100);
    const fresh = readArchive("b", "/f", 1, 100);
    const state = stateFrom([old, fresh]);
    const msgs = messagesFor([old, fresh], { a: 100, b: 100 });

    const result = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(HUGE_WINDOW),
      CWD,
      new Set(["previously-evicted"]),
      cfg(),
      new Map([["a", false]])
    );

    expect(result.has("previously-evicted")).toBe(true);
  });

  it("does nothing when the context window is unknown", () => {
    const old = readArchive("a", "/f", 1, 100);
    const fresh = readArchive("b", "/f", 1, 100);
    const state = stateFrom([old, fresh]);
    const msgs = messagesFor([old, fresh], { a: 100, b: 100 });

    const result = selectEvictionCandidates(
      msgs,
      state.archivesByPath,
      state.activeArchives,
      usage(null),
      CWD,
      new Set(),
      cfg(),
      new Map([["a", true]])
    );

    expect(result.size).toBe(0);
  });
});
