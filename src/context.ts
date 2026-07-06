import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArchiveState } from "./state";
import { checkStaleness } from "./utils";

export function createContextHandler(pi: ExtensionAPI, state: ArchiveState) {
  const { activeArchives, rebuildState } = state;

  pi.on("context", async (event, ctx: ExtensionContext) => {
    try {
      rebuildState(ctx);

      const updated = event.messages.map(msg => {
        if (msg.role !== "toolResult") return msg;

        // Find if this toolResult has a matching archive record
        const arc = Array.from(activeArchives.values()).find(
          a => a.toolCallId === msg.toolCallId
        );

        if (!arc) return msg;

        // Verify if the referenced file lines on disk have changed
        const isStale = checkStaleness(arc, ctx.cwd);
        if (isStale) {
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
