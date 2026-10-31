import { useEffect, useMemo, useState } from "react";
import { rankFiles } from "../../lib";
import { searchWorkspaceFiles, useStore } from "../../store";
import type { WorkspaceFileEntry } from "../../types";

/**
 * Files matching `query`, best first; null means no search is open. A project
 * too big for the list in memory is searched in the engine instead, so a file
 * past the cap can still be found.
 */
export function useFileSearch(query: string | null, limit: number): WorkspaceFileEntry[] {
  const files = useStore((s) => s.workspaceFiles);
  const truncated = useStore((s) => s.filesTruncated);
  const [remote, setRemote] = useState<WorkspaceFileEntry[] | null>(null);
  const q = query?.trim() ?? "";

  useEffect(() => {
    setRemote(null);
    if (!truncated || !q) return;
    let active = true;
    const timer = setTimeout(() => {
      searchWorkspaceFiles(q)
        .then((found) => {
          if (active) setRemote(found);
        })
        .catch(() => {});
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [truncated, q]);

  return useMemo(() => {
    if (query === null) return [];
    return rankFiles(
      (remote ?? files).filter((f) => f.kind === "file"),
      q,
      limit
    );
  }, [query, q, remote, files, limit]);
}
