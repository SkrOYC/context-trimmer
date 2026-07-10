import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArchivedResult } from "./types";
import { ARCHIVE_TYPE, getArchiveGroupKey } from "./types";

export interface ArchiveState {
  activeArchives: Map<string, ArchivedResult>;
  archivesByPath: Map<string, ArchivedResult[]>;
  rebuildState: (ctx: ExtensionContext) => void;
  registerArchive: (arc: ArchivedResult) => void;
}

export function createArchiveState(): ArchiveState {
  const activeArchives = new Map<string, ArchivedResult>();
  const archivesByPath = new Map<string, ArchivedResult[]>();

  function rebuildState(ctx: ExtensionContext) {
    activeArchives.clear();
    archivesByPath.clear();
    const branch = ctx.sessionManager.getBranch();

    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === ARCHIVE_TYPE) {
        const arc = entry.data as ArchivedResult;
        if (arc.pointerId) {
          registerArchive(arc);
        }
      }
    }
  }

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

  return { activeArchives, archivesByPath, rebuildState, registerArchive };
}
