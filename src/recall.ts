import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArchiveState } from "./state";
import { checkStaleness } from "./utils";

export function createRecallTool(pi: ExtensionAPI, state: ArchiveState) {
  const { activeArchives, rebuildState } = state;

  pi.registerTool({
    name: "recall_result",
    label: "Recall Result",
    description: "Retrieve complete or older tool result payloads from the results archive.",
    parameters: Type.Object({
      pointer_id: Type.String({ description: "The pointer ID, e.g. ptr_abc123" })
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      try {
        rebuildState(ctx);

        const pointerId = params.pointer_id;
        const arc = activeArchives.get(pointerId);

        if (!arc) {
          return {
            content: [{ type: "text", text: `Error: Pointer ${pointerId} not found in this branch.` }],
            isError: true,
            details: { status: "not_found" }
          } as any;
        }

        const isStale = checkStaleness(arc, ctx.cwd);
        const originalContent = JSON.parse(arc.originalContent);

        if (isStale) {
          const originalText = (originalContent as Array<{ type: string; text?: string }>)
            .map(c => c.type === "text" ? (c.text || "") : "")
            .join("\n");
          return {
            content: [{
              type: "text",
              text: `<recalled-stale-content>\n[Warning: Pointer ${pointerId} was invalidated. Raw content is shown below verbatim]\n\n${originalText}\n\n</recalled-stale-content>`
            }],
            details: { status: "invalidated" }
          };
        }

        return {
          content: originalContent,
          details: { status: "active" }
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error recalling result: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
          details: { status: "error" }
        } as any;
      }
    }
  });
}
