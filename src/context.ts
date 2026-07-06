import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArchivedResult } from "./types";
import type { ArchiveState } from "./state";
import { findSupersededArchives } from "./supersession";

export function createContextHandler(pi: ExtensionAPI, state: ArchiveState) {
  const { activeArchives, archivesByPath, rebuildState } = state;

  pi.on("context", async (event, ctx: ExtensionContext) => {
    try {
      rebuildState(ctx);

      // Compute superseded reads in one pass. Replacements are batched so the
      // KV-cache miss is paid once, and the next turn sees a stable prefix.
      const superseded = findSupersededArchives(event.messages, archivesByPath);

      // Build a reverse lookup from toolCallId to archive for fast replacement.
      const archiveByToolCallId = new Map<string, ArchivedResult>();
      for (const arc of activeArchives.values()) {
        archiveByToolCallId.set(arc.toolCallId, arc);
      }

      const updated = event.messages.map(msg => {
        if (msg.role !== "toolResult") return msg;

        const arc = archiveByToolCallId.get(msg.toolCallId);
        if (!arc) return msg;

        if (superseded.has(arc.pointerId)) {
          return {
            ...msg,
            content: [{
              type: "text" as const,
              text: `[Results Archive: ${arc.pointerId} (Invalidated - Stale)]`
            }]
          };
        }

        return msg;
      });

      return { messages: updated };
    } catch (err) {
      console.warn("[Context Trimmer] Failed to process context hooks:", err);
      return;
    }
  });
}
