import { Fragment, useEffect, useState } from "react";
import {
  addReviewComment,
  clearReviewComments,
  openWorkspaceFile,
  refreshWorkspaceDiff,
  removeReviewComment,
  rewindToCheckpoint,
  sendReviewCommentsToLead,
  showRewindPreview,
  showTurnDiff,
  showUncommittedDiff,
  useStore,
} from "../../store";
import type { Checkpoint, DiffFile, DiffLine } from "../../types";
import { ApprovalCard } from "../Conversation";
import { IconChevronDown, IconClose, IconRefresh } from "../icons";

const STATUS_BADGE: Record<DiffFile["status"], { label: string; cls: string; title: string }> = {
  modified: { label: "M", cls: "mod", title: "Modified" },
  added: { label: "A", cls: "add", title: "Added" },
  deleted: { label: "D", cls: "del", title: "Deleted" },
  untracked: { label: "U", cls: "add", title: "New, not tracked yet" },
  renamed: { label: "R", cls: "mod", title: "Renamed" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How long ago, in the fewest words that do. */
function age(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** What a checkpoint did, for the list. A turn the app didn't survive has no count. */
const checkpointDetail = (cp: Checkpoint) =>
  `${cp.changed === null ? "Didn't finish" : plural(cp.changed, "file")} · ${age(cp.at)}`;

export function DiffTab() {
  const workspace = useStore((s) => s.session?.workspace ?? null);
  const workspaceDiff = useStore((s) => s.workspaceDiff);
  const isGit = useStore((s) => s.diffIsGit);
  const workspaceTruncated = useStore((s) => s.diffTruncated);
  const approvals = useStore((s) => s.approvals);
  const reviewComments = useStore((s) => s.reviewComments);
  const checkpoints = useStore((s) => s.checkpoints);
  const shownView = useStore((s) => s.checkpointView);
  const busy = useStore((s) => s.busy);
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [draftTarget, setDraftTarget] = useState<{
    file: string;
    line: number;
    lineType: DiffLine["type"];
    code: string;
  } | null>(null);
  const [draftText, setDraftText] = useState("");

  useEffect(() => {
    if (workspace) void refreshWorkspaceDiff();
  }, [workspace]);

  // A checkpoint gone from the list can't be acted on, and leaves no way back from showing it.
  const view = shownView && checkpoints.some((c) => c.id === shownView.checkpointId) ? shownView : null;
  const diffFiles = view?.files ?? workspaceDiff;
  const truncated = view?.truncated ?? workspaceTruncated;
  const viewing = view ? (checkpoints.find((c) => c.id === view.checkpointId) ?? null) : null;
  const previewing = view?.mode === "rewind";

  const selectedPath =
    activeFile && diffFiles.some((f) => f.path === activeFile) ? activeFile : diffFiles[0]?.path ?? null;
  const currentFile = diffFiles.find((f) => f.path === selectedPath) ?? null;

  const submitComment = () => {
    if (!draftTarget || !draftText.trim()) return;
    addReviewComment({ ...draftTarget, comment: draftText.trim() });
    setDraftText("");
    setDraftTarget(null);
  };

  const summary = !isGit
    ? "Not a git repository"
    : diffFiles.length === 0
      ? view
        ? "No changes"
        : "No uncommitted changes"
      : `${diffFiles.length}${truncated ? "+" : ""} changed file${diffFiles.length === 1 ? "" : "s"}`;

  const rewind = async () => {
    if (!view) return;
    setRewinding(true);
    await rewindToCheckpoint(view.checkpointId, view.tree);
    setRewinding(false);
  };

  return (
    <div className="wb-diff" data-part="workbench-diff">
      <div className="wb-diff-toolbar">
        {checkpoints.length > 0 && (
          <button
            type="button"
            className="wb-mini-btn wb-turn-trigger"
            data-part="turn-picker"
            aria-expanded={turnsOpen}
            aria-controls="wb-turn-list"
            title={viewing?.label ?? "Uncommitted changes"}
            onClick={() => setTurnsOpen((open) => !open)}
          >
            <span className="wb-turn-trigger-label">{viewing?.label ?? "Uncommitted"}</span>
            <IconChevronDown />
          </button>
        )}
        <span className="muted small wb-diff-summary">{summary}</span>
        {diffFiles.length > 0 && !previewing && <span className="faint small">Click a line to comment</span>}
        <span className="spacer" />
        {view?.mode === "turn" && (
          <button
            type="button"
            className="wb-mini-btn"
            data-part="rewind"
            disabled={busy}
            title={busy ? "Wait for the turn to finish" : "See what going back to before this turn would change"}
            onClick={() => void showRewindPreview(view.checkpointId)}
          >
            {viewing?.kind === "rewind" ? "Undo…" : "Rewind…"}
          </button>
        )}
        <button
          type="button"
          className="wb-icon-btn"
          aria-label="Refresh diff"
          title="Refresh diff"
          onClick={() => {
            if (view) void (view.mode === "turn" ? showTurnDiff : showRewindPreview)(view.checkpointId);
            else void refreshWorkspaceDiff();
          }}
        >
          <IconRefresh />
        </button>
      </div>

      {turnsOpen && (
        <div id="wb-turn-list" className="wb-diff-filelist" role="listbox" aria-label="Turns" data-part="turn-list">
          <button
            type="button"
            role="option"
            aria-selected={view === null}
            className="wb-diff-file-btn wb-turn-row"
            data-selected={view === null}
            onClick={() => {
              setTurnsOpen(false);
              showUncommittedDiff();
            }}
          >
            <span className="wb-diff-filepath">Uncommitted changes</span>
          </button>
          {checkpoints.map((cp) => {
            const selected = view?.checkpointId === cp.id;
            return (
              <button
                key={cp.id}
                type="button"
                role="option"
                aria-selected={selected}
                className="wb-diff-file-btn wb-turn-row"
                data-selected={selected}
                title={cp.label}
                onClick={() => {
                  setTurnsOpen(false);
                  void showTurnDiff(cp.id);
                }}
              >
                <span className="wb-diff-filepath">{cp.label}</span>
                <span className="wb-diff-stats faint">{checkpointDetail(cp)}</span>
              </button>
            );
          })}
        </div>
      )}

      {previewing && viewing && (
        <div className="wb-review-banner" data-part="rewind-banner">
          <span className="wb-review-count">
            {viewing.kind === "rewind" ? "Undoing this" : "Going back to before this turn"} changes{" "}
            {plural(diffFiles.length, "file")}. The chat stays as it is.
            {(view?.blocked?.length ?? 0) > 0 &&
              ` ${plural(view?.blocked?.length ?? 0, "file")} stay as they are: this can't bring them back.`}
          </span>
          <span className="spacer" />
          <button type="button" className="wb-mini-btn" disabled={rewinding} onClick={() => void showTurnDiff(viewing.id)}>
            Cancel
          </button>
          <button
            type="button"
            className="wb-mini-btn primary"
            data-part="confirm-rewind"
            disabled={rewinding || busy || diffFiles.length === 0}
            onClick={() => void rewind()}
          >
            {viewing.kind === "rewind" ? "Undo" : "Rewind"}
          </button>
        </div>
      )}

      {approvals.map((a) => (
        <ApprovalCard key={a.approvalId} approval={a} />
      ))}

      {reviewComments.length > 0 && (
        <div className="wb-review-banner" data-part="review-banner">
          <span className="wb-review-count">
            {reviewComments.length} comment{reviewComments.length === 1 ? "" : "s"} to send
          </span>
          <span className="spacer" />
          <button type="button" className="wb-mini-btn" onClick={() => clearReviewComments()}>
            Discard
          </button>
          <button
            type="button"
            className="wb-mini-btn primary"
            data-part="send-review-comments"
            onClick={() => void sendReviewCommentsToLead()}
          >
            Send to lead
          </button>
        </div>
      )}

      {diffFiles.length > 0 && (
        <div className="wb-diff-split">
          <div className="wb-diff-filelist" role="listbox" aria-label="Changed files">
            {diffFiles.map((f) => {
              const badge = STATUS_BADGE[f.status];
              const isSelected = f.path === selectedPath;
              const fileCommentCount = reviewComments.filter((c) => c.file === f.path).length;
              return (
                <button
                  key={f.path}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="wb-diff-file-btn"
                  data-selected={isSelected}
                  onClick={() => setActiveFile(f.path)}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                >
                  <span className={`wb-status-badge ${badge.cls}`} title={badge.title}>
                    {badge.label}
                  </span>
                  <span className="wb-diff-filepath">{f.path}</span>
                  {fileCommentCount > 0 && <span className="wb-comment-pill">{fileCommentCount}</span>}
                  <span className="wb-diff-stats">
                    {f.additions > 0 && <span className="stat-add">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="stat-del">-{f.deletions}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          {currentFile && (
            <div className="wb-diff-hunks" data-part="diff-hunks">
              <div className="wb-viewer-head">
                <span className="wb-viewer-path" title={currentFile.path}>
                  {currentFile.oldPath ? `${currentFile.oldPath} → ${currentFile.path}` : currentFile.path}
                </span>
                <span className="spacer" />
                {currentFile.status !== "deleted" && (
                  <button
                    type="button"
                    className="wb-mini-btn"
                    onClick={() => void openWorkspaceFile(currentFile.path, true)}
                  >
                    Open file
                  </button>
                )}
              </div>

              {currentFile.note && (
                <div className="muted small wb-diff-note" data-part="diff-note">
                  {currentFile.note}
                </div>
              )}

              {currentFile.hunks.length > 0 && (
                <div className="wb-code-scroll">
                  {currentFile.hunks.map((hunk, hIdx) => (
                    <div key={hIdx} className="wb-hunk-block">
                      <div className="wb-hunk-header">{hunk.header}</div>
                      <table className="wb-code-table wb-diff-table">
                        <tbody>
                          {hunk.lines.map((line, lIdx) => {
                            const lineNo = line.newLine ?? line.oldLine ?? lIdx + 1;
                            const isDrafting =
                              draftTarget?.file === currentFile.path &&
                              draftTarget?.line === lineNo &&
                              draftTarget?.lineType === line.type;
                            const existing = reviewComments.filter(
                              (c) => c.file === currentFile.path && c.line === lineNo && c.lineType === line.type
                            );
                            return (
                              <Fragment key={`${hIdx}-${lIdx}`}>
                                <tr
                                  className={`wb-diff-row wb-diff-${line.type}`}
                                  data-part="diff-line"
                                  data-line={lineNo}
                                  onClick={() => {
                                    // Nothing has happened yet in a preview, so there's nothing to review.
                                    if (previewing) return;
                                    // Dragging across code to copy it isn't asking to comment.
                                    if (window.getSelection()?.isCollapsed === false) return;
                                    setDraftTarget({
                                      file: currentFile.path,
                                      line: lineNo,
                                      lineType: line.type,
                                      code: line.text,
                                    });
                                    setDraftText("");
                                  }}
                                >
                                  <td className="wb-code-num">{line.oldLine ?? ""}</td>
                                  <td className="wb-code-num">{line.newLine ?? ""}</td>
                                  <td className="wb-diff-sign">
                                    {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                                  </td>
                                  <td className="wb-code-line">{line.text || " "}</td>
                                </tr>
                                {existing.map((c) => (
                                  <tr key={c.id} className="wb-inline-comment-row" data-part="inline-review-comment">
                                    <td colSpan={4}>
                                      <div className="wb-inline-comment">
                                        <span className="wb-inline-comment-body">{c.comment}</span>
                                        <button
                                          type="button"
                                          className="wb-icon-btn"
                                          aria-label="Remove comment"
                                          onClick={() => removeReviewComment(c.id)}
                                        >
                                          <IconClose />
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                                {isDrafting && (
                                  <tr className="wb-inline-comment-row" data-part="inline-comment-editor">
                                    <td colSpan={4}>
                                      <div className="wb-inline-editor">
                                        <input
                                          type="text"
                                          className="wb-search-input"
                                          placeholder={`Comment on line ${lineNo}…`}
                                          aria-label="Inline review comment"
                                          autoFocus
                                          value={draftText}
                                          onChange={(e) => setDraftText(e.target.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") {
                                              e.preventDefault();
                                              submitComment();
                                            } else if (e.key === "Escape") {
                                              e.preventDefault();
                                              setDraftTarget(null);
                                            }
                                          }}
                                        />
                                        <button
                                          type="button"
                                          className="wb-mini-btn primary"
                                          disabled={!draftText.trim()}
                                          onClick={submitComment}
                                        >
                                          Add
                                        </button>
                                        <button
                                          type="button"
                                          className="wb-mini-btn"
                                          onClick={() => setDraftTarget(null)}
                                        >
                                          Cancel
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
