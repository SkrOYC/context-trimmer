import type {
  AgentMessage,
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
    getModel: () => undefined,
    getSignal: () => new AbortController().signal,
    getSystemPrompt: () => "",
    hasPendingMessages: () => false,
    isIdle: () => true,
    isProjectTrusted: () => true,
    sessionManager: {
      appendCustomEntry: () => undefined,
      getBranch: () => [],
    } as unknown as ExtensionContext["sessionManager"],
    shutdown: () => undefined,
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

export function replayTrace(
  trace: ParsedTrace,
  options: ReplayOptions
): TraceResult {
  const { contextWindow, cwd, selector } = options;
  const state = createArchiveState();
  const ctx = createMockExtensionContext(cwd);

  const turnResults: TurnResult[] = [];
  const alreadyReplaced = new Set<string>();
  let totalArchiveChars = 0;
  let totalReplacedChars = 0;
  let maxContextUsagePercent = 0;

  for (let turnIndex = 0; turnIndex < trace.turns.length; turnIndex += 1) {
    const turn = trace.turns[turnIndex];
    if (!turn) {
      continue;
    }

    const archiveRecord = archiveToolResult(state, turn.toolResult, ctx);
    if (archiveRecord) {
      totalArchiveChars += archiveRecord.originalContent.length;
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

    const toReplace = selector(
      messages,
      state.archivesByPath,
      state.activeArchives,
      usage,
      cwd
    );

    const newlyReplaced = new Set<string>();
    for (const pointerId of toReplace) {
      if (!alreadyReplaced.has(pointerId)) {
        newlyReplaced.add(pointerId);
        alreadyReplaced.add(pointerId);
      }
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

    turnResults.push({
      baselineTokens,
      compiledMessages: compiledMessages.length,
      compiledTokens,
      contextUsagePercent: percent,
      replacedArchives: newlyReplaced.size,
      replacedChars: cost.replacedTokens * 4,
      totalArchiveChars,
      totalChars,
    });
  }

  return {
    maxContextUsagePercent,
    metadata: trace.metadata,
    replacedCount: alreadyReplaced.size,
    source: trace.source,
    totalArchiveChars,
    totalReplacedChars,
    turnResults,
  };
}
