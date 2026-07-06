import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createArchiveHandler } from "./archive";
import { createContextHandler } from "./context";
import { createRecallTool } from "./recall";
import { createArchiveState } from "./state";

export default function (pi: ExtensionAPI) {
  const state = createArchiveState();

  // Session state lifecycle hooks
  pi.on("session_start", (_, ctx: ExtensionContext) => state.rebuildState(ctx));
  pi.on("session_tree", (_, ctx: ExtensionContext) => state.rebuildState(ctx));

  createArchiveHandler(pi, state);
  createContextHandler(pi, state);
  createRecallTool(pi, state);
}
