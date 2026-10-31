import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { insertIntoComposer, openWorkspaceFile, refreshWorkspaceFiles, toast, useStore } from "../../store";
import { IconChevronRight, IconRefresh } from "../icons";
import { useFileSearch } from "./useFileSearch";

const CodeViewer = lazy(() => import("./CodeViewer").then((m) => ({ default: m.CodeViewer })));

const FILTER_RESULTS = 300;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Each folder a path sits in, outermost first. */
function parentsOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function FilesTab() {
  const workspace = useStore((s) => s.session?.workspace ?? null);
  const files = useStore((s) => s.workspaceFiles);
  const truncated = useStore((s) => s.filesTruncated);
  const selectedFile = useStore((s) => s.selectedFile);
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const tree = useRef<HTMLDivElement>(null);
  const autoOpened = useRef<string | null>(null);

  const filtering = filter.trim().length > 0;
  const matches = useFileSearch(filtering ? filter : null, FILTER_RESULTS);

  useEffect(() => {
    if (workspace) void refreshWorkspaceFiles();
  }, [workspace]);

  // Something to read on first arrival. Once per project: a file that can't
  // open isn't worth trying on every refresh.
  useEffect(() => {
    if (selectedFile || !workspace || autoOpened.current === workspace) return;
    const onlyFiles = files.filter((f) => f.kind === "file");
    if (onlyFiles.length === 0) return;
    autoOpened.current = workspace;
    const preferred =
      onlyFiles.find((f) => /^readme\.md$/i.test(f.path)) ??
      onlyFiles.find((f) => f.path === "package.json") ??
      onlyFiles[0];
    void openWorkspaceFile(preferred.path);
  }, [files, selectedFile, workspace]);

  // A file opened from elsewhere (Quick Open, the Diff tab) shows in the tree.
  useEffect(() => {
    if (!selectedFile) return;
    setExpanded((prev) => {
      const closed = parentsOf(selectedFile.path).filter((dir) => !prev[dir]);
      return closed.length === 0 ? prev : { ...prev, ...Object.fromEntries(closed.map((dir) => [dir, true])) };
    });
  }, [selectedFile?.path]);

  useEffect(() => {
    tree.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedFile?.path, filtering]);

  const visible = useMemo(() => {
    if (filtering) return matches;
    return files.filter((entry) => parentsOf(entry.path).every((dir) => expanded[dir]));
  }, [filtering, matches, files, expanded]);

  return (
    <div className="wb-files" data-part="workbench-files">
      <div className="wb-files-sidebar">
        <div className="wb-files-toolbar">
          <input
            type="search"
            className="wb-search-input"
            placeholder="Filter files…"
            aria-label="Filter workspace files"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="wb-icon-btn"
            aria-label="Refresh files"
            title="Refresh files"
            onClick={() => void refreshWorkspaceFiles()}
          >
            <IconRefresh />
          </button>
        </div>
        <div ref={tree} className="wb-file-tree" role="tree" aria-label="Workspace files">
          {visible.length === 0 ? (
            <div className="muted small wb-empty-note">{filtering ? "No matching files." : "No files here yet."}</div>
          ) : (
            visible.map((entry) => {
              const depth = filtering ? 0 : parentsOf(entry.path).length;
              const isDir = entry.kind === "dir";
              const isSelected = !isDir && selectedFile?.path === entry.path;
              const isOpen = isDir && Boolean(expanded[entry.path]);
              return (
                <button
                  key={entry.path}
                  type="button"
                  role="treeitem"
                  aria-selected={isSelected}
                  aria-expanded={isDir ? isOpen : undefined}
                  aria-level={depth + 1}
                  className="wb-tree-item"
                  data-kind={entry.kind}
                  data-selected={isSelected}
                  style={{ paddingLeft: `${6 + depth * 12}px` }}
                  onClick={() => {
                    if (isDir) setExpanded((prev) => ({ ...prev, [entry.path]: !prev[entry.path] }));
                    else void openWorkspaceFile(entry.path);
                  }}
                  title={entry.path}
                >
                  <span className="wb-tree-glyph" data-open={isOpen} aria-hidden="true">
                    {isDir && <IconChevronRight />}
                  </span>
                  <span className="wb-tree-name">{filtering ? entry.path : entry.name}</span>
                </button>
              );
            })
          )}
          {truncated && !filtering && (
            <div className="muted small wb-empty-note">
              This project is too big to list in full. Filter to find anything that isn't shown.
            </div>
          )}
        </div>
      </div>

      <div className="wb-file-viewer" data-part="file-viewer">
        {selectedFile ? (
          <>
            <div className="wb-viewer-head">
              <span className="wb-viewer-path" title={selectedFile.path}>
                {selectedFile.path}
              </span>
              <span className="muted small wb-viewer-meta">
                {formatSize(selectedFile.size)}
                {!selectedFile.binary ? ` · ${selectedFile.totalLines} lines` : ""}
                {selectedFile.truncated && !selectedFile.binary ? " shown" : ""}
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="wb-mini-btn"
                onClick={() => insertIntoComposer(`@${selectedFile.path} `)}
                title="Mention this file in the composer"
              >
                @ Mention
              </button>
              {!selectedFile.binary && (
                <button
                  type="button"
                  className="wb-mini-btn"
                  onClick={() => {
                    void navigator.clipboard?.writeText(selectedFile.content);
                    toast("notice", "Copied file contents");
                  }}
                >
                  Copy
                </button>
              )}
            </div>
            {selectedFile.binary ? (
              <div className="muted small wb-empty-note">Binary file: nothing to read as text.</div>
            ) : (
              <Suspense fallback={null}>
                <CodeViewer path={selectedFile.path} content={selectedFile.content} />
              </Suspense>
            )}
          </>
        ) : (
          <div className="muted small wb-empty-note">Pick a file to read it here.</div>
        )}
      </div>
    </div>
  );
}
