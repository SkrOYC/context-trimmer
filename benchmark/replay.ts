import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionContext,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { type ArchiveState, createArchiveState } from "../src/state";
import { type ArchivedResult, POLICIES } from "../src/types";
import { getHash } from "../src/utils";
import type { CandidateSelector } from "./algorithms";
import { computeTurnCost, messageText } from "./cost";
import type { ParsedTrace, TraceResult, TurnResult } from "./types";

function createMockExtensionContext(cwd: string): ExtensionContext {
  return {
    abort: () => undefined,
    compact: () => undefined,
    cwd,
    getContextUsage: () => undefined,
    getSystemPrompt: () => "",
    hasPendingMessages: () => false,
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    mode: "print",
    model: undefined,
    modelRegistry: {} as unknown as ExtensionContext["modelRegistry"],
    sessionManager: {
      appendCustomEntry: () => undefined,
      getBranch: () => [],
    } as unknown as ExtensionContext["sessionManager"],
    shutdown: () => undefined,
    signal: undefined,
    ui: {} as unknown as ExtensionContext["ui"],
  };
}

function archiveToolResult(
  state: ArchiveState,
  event: ToolResultEvent,
  _ctx: ExtensionContext
): ArchivedResult | undefined {
  const policy = POLICIES.find((p) => p.toolName === event.toolName);
  if (!policy) {
    return;
  }

  const contentStr = policy.extractContent(event);
  if (contentStr === undefined) {
    return;
  }

  const paramKey = policy.getParameterKey(event.input);
  if (!paramKey) {
    return;
  }

  const offset = Number(event.input.offset) || 1;
  const lineHashes = contentStr.split("\n").map((line) => getHash(line));

  const archiveRecord: ArchivedResult = {
    lineHashes,
    originalContent: JSON.stringify(event.content),
    parameterKey: paramKey,
    pointerId: `ptr_${Math.random().toString(36).slice(2, 10)}`,
    stalenessStrategy: policy.stalenessStrategy,
    startLine: offset,
    supersessionStrategy: policy.supersessionStrategy,
    timestamp: Date.now(),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
  };

  state.registerArchive(archiveRecord);
  return archiveRecord;
}

function buildMessages(trace: ParsedTrace, upToTurn: number): AgentMessage[] {
  const messages: AgentMessage[] = [];

  for (let i = 0; i <= upToTurn; i += 1) {
    const turn = trace.turns[i];
    if (!turn) {
      continue;
    }

    messages.push({
      content: [{ text: turn.observation, type: "text" as const }],
      isError: false,
      role: "toolResult",
      timestamp: Date.now(),
      toolCallId: turn.toolResult.toolCallId,
      toolName: turn.toolResult.toolName,
    });
  }

  return messages;
}

function applyReplacements(
  messages: AgentMessage[],
  toReplace: Set<string>,
  activeArchives: Map<string, ArchivedResult>
): AgentMessage[] {
  const archiveByToolCallId = new Map<string, ArchivedResult>();
  for (const arc of activeArchives.values()) {
    archiveByToolCallId.set(arc.toolCallId, arc);
  }

  return messages.map((msg) => {
    if (msg.role !== "toolResult") {
      return msg;
    }

    const arc = archiveByToolCallId.get(msg.toolCallId);
    if (!(arc && toReplace.has(arc.pointerId))) {
      return msg;
    }

    return {
      ...msg,
      content: [
        {
          text: `[Results Archive: ${arc.pointerId} (Invalidated - Stale)]`,
          type: "text" as const,
        },
      ],
    };
  });
}

export interface ReplayOptions {
  contextWindow: number;
  cwd: string;
  selector: CandidateSelector;
}

interface TraceFileHistory {
  // path -> sorted turn indices where a write/edit mutated it.
  mutationTurns: Map<string, number[]>;
  // path -> sorted turn indices where a read observed it.
  readTurns: Map<string, number[]>;
}

function buildFileHistory(trace: ParsedTrace): TraceFileHistory {
  const mutationTurns = new Map<string, number[]>();
  const readTurns = new Map<string, number[]>();

  trace.turns.forEach((turn, i) => {
    if (turn.mutatesPath) {
      const list = mutationTurns.get(turn.mutatesPath) ?? [];
      list.push(i);
      mutationTurns.set(turn.mutatesPath, list);
    }
    const { toolName, input } = turn.toolResult;
    if (toolName === "read" && typeof input.path === "string") {
      const list = readTurns.get(input.path) ?? [];
      list.push(i);
      readTurns.set(input.path, list);
    }
  });

  return { mutationTurns, readTurns };
}

function hasEventInRange(
  turns: number[] | undefined,
  afterExclusive: number,
  untilInclusive: number
): boolean {
  if (!turns) {
    return false;
  }
  return turns.some((t) => t > afterExclusive && t <= untilInclusive);
}

// Synthesized staleness for the current turn: a read archive is stale if its
// file was written/edited after the read and at or before now; immutable-tool
// archives are "assumed stale" exactly as production treats them.
function buildStalenessOverride(
  activeArchives: Map<string, ArchivedResult>,
  pathByPointer: Map<string, string>,
  creationTurnByPointer: Map<string, number>,
  mutationTurns: Map<string, number[]>,
  turnIndex: number
): Map<string, boolean> {
  const override = new Map<string, boolean>();
  for (const arc of activeArchives.values()) {
    const path = pathByPointer.get(arc.pointerId);
    if (path === undefined) {
      override.set(arc.pointerId, true);
      continue;
    }
    const createdAt = creationTurnByPointer.get(arc.pointerId) ?? -1;
    override.set(
      arc.pointerId,
      hasEventInRange(mutationTurns.get(path), createdAt, turnIndex)
    );
  }
  return override;
}

// Premature recalls: we evicted a read archive, then the trace's own agent read
// that same file again later — evidence the content still had value.
function countPrematureRecalls(
  evictionTurnByPointer: Map<string, number>,
  pathByPointer: Map<string, string>,
  readTurns: Map<string, number[]>
): number {
  let count = 0;
  for (const [pointerId, evictionTurn] of evictionTurnByPointer) {
    const path = pathByPointer.get(pointerId);
    if (path === undefined) {
      continue;
    }
    if (
      hasEventInRange(
        readTurns.get(path),
        evictionTurn,
        Number.POSITIVE_INFINITY
      )
    ) {
      count += 1;
    }
  }
  return count;
}

export function replayTrace(
  trace: ParsedTrace,
  options: ReplayOptions
): TraceResult {
  const { contextWindow, cwd, selector } = options;
  const state = createArchiveState();
  const ctx = createMockExtensionContext(cwd);
  const fileHistory = buildFileHistory(trace);

  const turnResults: TurnResult[] = [];
  const alreadyReplaced = new Set<string>();
  // Per-archive bookkeeping for synthesized staleness and the re-reference
  // (premature-recall) penalty.
  const creationTurnByPointer = new Map<string, number>();
  const pathByPointer = new Map<string, string>();
  const evictionTurnByPointer = new Map<string, number>();
  let previousCompiledMessages: AgentMessage[] | undefined;
  let totalArchiveChars = 0;
  let totalReplacedChars = 0;
  let maxContextUsagePercent = 0;
  let maxCompiledUsagePercent = 0;
  let overflowTokensBaseline = 0;
  let overflowTokensCompiled = 0;
  let invalidationEvents = 0;

  for (let turnIndex = 0; turnIndex < trace.turns.length; turnIndex += 1) {
    const turn = trace.turns[turnIndex];
    if (!turn) {
      continue;
    }

    const archiveRecord = archiveToolResult(state, turn.toolResult, ctx);
    if (archiveRecord) {
      totalArchiveChars += archiveRecord.originalContent.length;
      creationTurnByPointer.set(archiveRecord.pointerId, turnIndex);
      if (
        archiveRecord.stalenessStrategy !== "immutable" &&
        typeof turn.toolResult.input.path === "string"
      ) {
        pathByPointer.set(archiveRecord.pointerId, turn.toolResult.input.path);
      }
    }

    const messages = buildMessages(trace, turnIndex);
    const totalChars = messages.reduce(
      (sum, msg) => sum + messageText(msg).length,
      0
    );
    const percent = Math.min(
      99,
      Math.floor((totalChars / contextWindow) * 100)
    );
    maxContextUsagePercent = Math.max(maxContextUsagePercent, percent);

    const usage = {
      contextWindow,
      percent,
      tokens: Math.floor(totalChars / 4),
    };

    const stalenessOverride = buildStalenessOverride(
      state.activeArchives,
      pathByPointer,
      creationTurnByPointer,
      fileHistory.mutationTurns,
      turnIndex
    );

    const toReplace = selector(
      messages,
      state.archivesByPath,
      state.activeArchives,
      usage,
      cwd,
      alreadyReplaced,
      stalenessOverride
    );

    const newlyReplaced = new Set<string>();
    for (const pointerId of toReplace) {
      if (!alreadyReplaced.has(pointerId)) {
        newlyReplaced.add(pointerId);
        alreadyReplaced.add(pointerId);
        evictionTurnByPointer.set(pointerId, turnIndex);
      }
    }

    // Any turn that introduces a new replacement rewrites the KV-cache suffix
    // from the oldest replaced message onward. Counting these turns (not the
    // number of archives replaced) is the anti-thrash signal: the decisive
    // batch model frees many archives across few events; the incremental model
    // dribbles replacements across many events, paying the invalidation each
    // time.
    if (newlyReplaced.size > 0) {
      invalidationEvents += 1;
    }

    const compiledMessages = applyReplacements(
      messages,
      alreadyReplaced,
      state.activeArchives
    );

    const archiveByToolCallId = new Map<string, ArchivedResult>();
    for (const arc of state.activeArchives.values()) {
      archiveByToolCallId.set(arc.toolCallId, arc);
    }

    const cost = computeTurnCost(
      messages,
      compiledMessages,
      newlyReplaced,
      archiveByToolCallId
    );
    totalReplacedChars += cost.replacedTokens * 4;

    const baselineTokens = messages.reduce(
      (sum, msg) => sum + Math.ceil(messageText(msg).length / 4),
      0
    );
    const compiledTokens = compiledMessages.reduce(
      (sum, msg) => sum + Math.ceil(messageText(msg).length / 4),
      0
    );

    // Track how close to (or past) the window each strategy runs. Tokens over
    // the window are the real cost the trimmer exists to avoid: in a live agent
    // they force compaction or an outright request failure.
    overflowTokensBaseline += Math.max(0, baselineTokens - contextWindow);
    overflowTokensCompiled += Math.max(0, compiledTokens - contextWindow);
    maxCompiledUsagePercent = Math.max(
      maxCompiledUsagePercent,
      Math.floor((compiledTokens / contextWindow) * 100)
    );

    const firstChangedIndex = findFirstChangedIndex(
      previousCompiledMessages,
      compiledMessages
    );
    const cacheReadTokens = previousCompiledMessages
      ? compiledMessages
          .slice(0, firstChangedIndex)
          .reduce((sum, msg) => sum + Math.ceil(messageText(msg).length / 4), 0)
      : 0;
    const inputTokens = compiledMessages
      .slice(firstChangedIndex)
      .reduce((sum, msg) => sum + Math.ceil(messageText(msg).length / 4), 0);
    const cacheWriteTokens = inputTokens;

    previousCompiledMessages = compiledMessages;

    turnResults.push({
      baselineTokens,
      cacheReadTokens,
      cacheWriteTokens,
      compiledMessages: compiledMessages.length,
      compiledTokens,
      contextUsagePercent: percent,
      inputTokens,
      replacedArchives: newlyReplaced.size,
      replacedChars: cost.replacedTokens * 4,
      totalArchiveChars,
      totalChars,
    });
  }

  const prematureRecalls = countPrematureRecalls(
    evictionTurnByPointer,
    pathByPointer,
    fileHistory.readTurns
  );

  return {
    invalidationEvents,
    maxCompiledUsagePercent,
    maxContextUsagePercent,
    metadata: trace.metadata,
    overflowTokensBaseline,
    overflowTokensCompiled,
    prematureRecalls,
    replacedCount: alreadyReplaced.size,
    source: trace.source,
    totalArchiveChars,
    totalReplacedChars,
    turnResults,
  };
}

function findFirstChangedIndex(
  previous: AgentMessage[] | undefined,
  current: AgentMessage[]
): number {
  if (!previous) {
    return 0;
  }

  const maxIndex = Math.min(previous.length, current.length);
  for (let i = 0; i < maxIndex; i += 1) {
    const prevMsg = previous[i];
    const currMsg = current[i];
    if (
      !(prevMsg && currMsg) ||
      messageText(prevMsg) !== messageText(currMsg)
    ) {
      return i;
    }
  }

  if (previous.length !== current.length) {
    return maxIndex;
  }

  return current.length;
}
