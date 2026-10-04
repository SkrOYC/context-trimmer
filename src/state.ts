import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionContext,
  SessionEntry,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { buildArchiveRecord } from "./archive";
import type { ArchivedResult } from "./types";
import { ARCHIVE_TYPE, getArchiveGroupKey, POLICIES } from "./types";

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

export interface ArchiveState {
  activeArchives: Map<string, ArchivedResult>;
  archivesByPath: Map<string, ArchivedResult[]>;
  // Pointers already replaced by a compact archive marker in earlier turns.
  // Eviction is append-only: once a pointer is here it stays replaced for the
  // rest of the session, so we never re-invalidate a KV-cache suffix we already
  // paid to rewrite. Deliberately NOT cleared by rebuildState.
  evictedPointers: Set<string>;
  rebuildState: (ctx: ExtensionContext) => void;
  registerArchive: (arc: ArchivedResult) => void;
}

interface BackfillInputs {
  archivedToolCallIds: Set<string>;
  argsByToolCallId: Map<string, Record<string, unknown>>;
  pending: ToolResultMessage[];
}

function collectToolCallArguments(
  content: AssistantContent,
  out: Map<string, Record<string, unknown>>
): void {
  for (const part of content) {
    if (part.type === "toolCall") {
      out.set(part.id, part.arguments);
    }
  }
}

function registerCustomEntry(
  arc: ArchivedResult,
  archivedToolCallIds: Set<string>,
  registerArchive: (arc: ArchivedResult) => void
): void {
  if (!arc.pointerId) {
    return;
  }
  if (arc.toolCallId) {
    archivedToolCallIds.add(arc.toolCallId);
  }
  registerArchive(arc);
}

// Walk the branch once, registering existing archives and collecting the tool
// call arguments and tool results needed to backfill the rest.
function scanBranch(
  branch: SessionEntry[],
  registerArchive: (arc: ArchivedResult) => void
): BackfillInputs {
  const archivedToolCallIds = new Set<string>();
  const argsByToolCallId = new Map<string, Record<string, unknown>>();
  const pending: ToolResultMessage[] = [];

  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === ARCHIVE_TYPE) {
      registerCustomEntry(
        entry.data as ArchivedResult,
        archivedToolCallIds,
        registerArchive
      );
      continue;
    }

    if (entry.type !== "message") {
      continue;
    }
    const { message } = entry;
    if (message.role === "assistant") {
      collectToolCallArguments(message.content, argsByToolCallId);
    } else if (message.role === "toolResult") {
      pending.push(message);
    }
  }

  return { archivedToolCallIds, argsByToolCallId, pending };
}

// Retroactively archive tool results that predate the extension so a resumed or
// newly-adopted session is trimmed as if it had been active from the start.
// Cached by tool call id, so only the first rebuild pays the hashing cost.
function backfillPending(
  inputs: BackfillInputs,
  backfillCache: Map<string, ArchivedResult>,
  registerArchive: (arc: ArchivedResult) => void
): void {
  const { archivedToolCallIds, argsByToolCallId, pending } = inputs;

  for (const message of pending) {
    const { toolCallId, toolName, isError } = message;
    if (archivedToolCallIds.has(toolCallId)) {
      continue;
    }
    const cached = backfillCache.get(toolCallId);
    if (cached) {
      registerArchive(cached);
      continue;
    }
    const policy = POLICIES.find((p) => p.toolName === toolName);
    if (!policy || isError) {
      continue;
    }
    const arc = buildArchiveRecord(policy, {
      ...message,
      input: argsByToolCallId.get(toolCallId) ?? {},
    } as unknown as ToolResultEvent);
    if (!arc) {
      continue;
    }
    backfillCache.set(toolCallId, arc);
    registerArchive(arc);
  }
}

export function createArchiveState(): ArchiveState {
  const activeArchives = new Map<string, ArchivedResult>();
  const archivesByPath = new Map<string, ArchivedResult[]>();
  const evictedPointers = new Set<string>();
  // Derived, not persisted.
  const backfillCache = new Map<string, ArchivedResult>();

  function registerArchive(arc: ArchivedResult) {
    if (activeArchives.has(arc.pointerId)) {
      return;
    }

    activeArchives.set(arc.pointerId, arc);
    const groupKey = getArchiveGroupKey(arc.toolName, arc.parameterKey);
    const list = archivesByPath.get(groupKey) ?? [];
    list.push(arc);
    archivesByPath.set(groupKey, list);
  }

  function rebuildState(ctx: ExtensionContext) {
    activeArchives.clear();
    archivesByPath.clear();
    const inputs = scanBranch(ctx.sessionManager.getBranch(), registerArchive);
    backfillPending(inputs, backfillCache, registerArchive);
  }

  return {
    activeArchives,
    archivesByPath,
    evictedPointers,
    rebuildState,
    registerArchive,
  };
}
