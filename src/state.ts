import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArchivedResult } from "./types";
import { ARCHIVE_TYPE } from "./types";

export interface ArchiveState {
  activeArchives: Map<string, ArchivedResult>;
  rebuildState: (ctx: ExtensionContext) => void;
}

export function createArchiveState(): ArchiveState {
  const activeArchives = new Map<string, ArchivedResult>();

  function rebuildState(ctx: ExtensionContext) {
    activeArchives.clear();
    const branch = ctx.sessionManager.getBranch();

    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === ARCHIVE_TYPE) {
        const arc = entry.data as ArchivedResult;
        if (arc && arc.pointerId) {
          activeArchives.set(arc.pointerId, arc);
        }
      }
    }
  }

  return { activeArchives, rebuildState };
}
