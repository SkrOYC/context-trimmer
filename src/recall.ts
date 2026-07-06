import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ArchiveState } from "./state";
import { checkStaleness } from "./utils";

export function createRecallTool(pi: ExtensionAPI, state: ArchiveState) {
  const { activeArchives, rebuildState } = state;

  pi.registerTool({
    description:
      "Retrieve complete or older tool result payloads from the results archive.",
    execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      try {
        rebuildState(ctx);

        const pointerId = params.pointer_id;
        const arc = activeArchives.get(pointerId);

        if (!arc) {
          return Promise.resolve({
            content: [
              {
                text: `Error: Pointer ${pointerId} not found in this branch.`,
                type: "text",
              },
            ],
            details: { status: "not_found" },
            isError: true,
          });
        }

        const isStale = checkStaleness(arc, ctx.cwd);
        const originalContent = JSON.parse(arc.originalContent);

        if (isStale) {
          const originalText = (
            originalContent as Array<{ type: string; text?: string }>
          )
            .map((c) => (c.type === "text" ? c.text || "" : ""))
            .join("\n");
          return Promise.resolve({
            content: [
              {
                text: `<recalled-stale-content>\n[Warning: Pointer ${pointerId} was invalidated. Raw content is shown below verbatim]\n\n${originalText}\n\n</recalled-stale-content>`,
                type: "text",
              },
            ],
            details: { status: "invalidated" },
          });
        }

        return Promise.resolve({
          content: originalContent,
          details: { status: "active" },
        });
      } catch (err) {
        return Promise.resolve({
          content: [
            {
              text: `Error recalling result: ${err instanceof Error ? err.message : String(err)}`,
              type: "text",
            },
          ],
          details: { status: "error" },
          isError: true,
        });
      }
    },
    label: "Recall Result",
    name: "recall_result",
    parameters: Type.Object({
      pointer_id: Type.String({
        description: "The pointer ID, e.g. ptr_abc123",
      }),
    }),
  });
}
