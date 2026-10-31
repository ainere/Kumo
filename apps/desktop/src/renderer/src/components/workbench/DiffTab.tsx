import { Fragment, useEffect, useState } from "react";
import {
  addReviewComment,
  clearReviewComments,
  openWorkspaceFile,
  refreshWorkspaceDiff,
  removeReviewComment,
  sendReviewCommentsToLead,
  useStore,
} from "../../store";
import type { DiffFile, DiffLine } from "../../types";
import { ApprovalCard } from "../Conversation";
import { IconClose, IconRefresh } from "../icons";

const STATUS_BADGE: Record<DiffFile["status"], { label: string; cls: string; title: string }> = {
  modified: { label: "M", cls: "mod", title: "Modified" },
  added: { label: "A", cls: "add", title: "Added" },
  deleted: { label: "D", cls: "del", title: "Deleted" },
  untracked: { label: "U", cls: "add", title: "New, not tracked yet" },
  renamed: { label: "R", cls: "mod", title: "Renamed" },
};

export function DiffTab() {
  const workspace = useStore((s) => s.session?.workspace ?? null);
  const diffFiles = useStore((s) => s.workspaceDiff);
  const isGit = useStore((s) => s.diffIsGit);
  const truncated = useStore((s) => s.diffTruncated);
  const approvals = useStore((s) => s.approvals);
  const reviewComments = useStore((s) => s.reviewComments);
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
      ? "No uncommitted changes"
      : `${diffFiles.length}${truncated ? "+" : ""} changed file${diffFiles.length === 1 ? "" : "s"}`;

  return (
    <div className="wb-diff" data-part="workbench-diff">
      <div className="wb-diff-toolbar">
        <span className="muted small">{summary}</span>
        {diffFiles.length > 0 && <span className="faint small">Click a line to comment</span>}
        <span className="spacer" />
        <button
          type="button"
          className="wb-icon-btn"
          aria-label="Refresh diff"
          title="Refresh diff"
          onClick={() => void refreshWorkspaceDiff()}
        >
          <IconRefresh />
        </button>
      </div>

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
