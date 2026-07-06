import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getEvictionContext, selectEvictionCandidates } from "./eviction";
import type { ArchiveState } from "./state";
import { findSupersededArchives } from "./supersession";
import type { ArchivedResult } from "./types";

export function createContextHandler(pi: ExtensionAPI, state: ArchiveState) {
  const { activeArchives, archivesByPath, rebuildState } = state;

  pi.on("context", (event, ctx: ExtensionContext) => {
    try {
      rebuildState(ctx);

      // Compute superseded reads and pressure-based eviction candidates in one
      // pass. Replacements are batched so the KV-cache miss is paid once, and
      // the next turn sees a stable prefix.
      const superseded = findSupersededArchives(event.messages, archivesByPath);
      const toReplace = selectEvictionCandidates(
        event.messages,
        archivesByPath,
        activeArchives,
        getEvictionContext(ctx),
        superseded,
        ctx.cwd
      );

      // Build a reverse lookup from toolCallId to archive for fast replacement.
      const archiveByToolCallId = new Map<string, ArchivedResult>();
      for (const arc of activeArchives.values()) {
        archiveByToolCallId.set(arc.toolCallId, arc);
      }

      const updated = event.messages.map((msg) => {
        if (msg.role !== "toolResult") {
          return msg;
        }

        const arc = archiveByToolCallId.get(msg.toolCallId);
        if (!arc) {
          return msg;
        }

        if (toReplace.has(arc.pointerId)) {
          return {
            ...msg,
            content: [
              {
                text: `[Results Archive: ${arc.pointerId} (Invalidated - Stale)]`,
                type: "text" as const,
              },
            ],
          };
        }

        return msg;
      });

      return { messages: updated };
    } catch (err) {
      console.warn("[Context Trimmer] Failed to process context hooks:", err);
    }
  });
}
