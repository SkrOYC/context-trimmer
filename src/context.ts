import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getEvictionContext, selectEvictionCandidates } from "./eviction";
import type { ArchiveState } from "./state";
import type { ArchivedResult } from "./types";

export function createContextHandler(pi: ExtensionAPI, state: ArchiveState) {
  const { activeArchives, archivesByPath, rebuildState } = state;

  pi.on("context", (event, ctx: ExtensionContext) => {
    try {
      rebuildState(ctx);

      // Select archives to replace using a single eviction score. Supersession
      // coverage is one input to that score, not a separate automatic replacement
      // trigger, so we avoid unnecessary KV-cache invalidations.
      const toReplace = selectEvictionCandidates(
        event.messages,
        archivesByPath,
        activeArchives,
        getEvictionContext(ctx),
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
