/**
 * The Compare tab: two models take the same brief, each on a copy of the
 * project, and their changes sit side by side until one is kept. The engine
 * does the work (src/core/compare.js); this only starts it and shows it.
 */

import { useEffect, useState } from "react";
import {
  closeCompare,
  discardCompare,
  keepCompareSide,
  loadCatalog,
  loadCompareDiff,
  startCompare,
  useStore,
} from "../../store";
import type { CompareSide, CompareState, DiffFile } from "../../types";
import { findModel, ModelPicker, pickEffort, type ModelTarget } from "../settings/ModelPicker";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function CompareSetup() {
  const catalog = useStore((s) => s.catalog);
  const busy = useStore((s) => s.busy);
  const [brief, setBrief] = useState("");
  const [targets, setTargets] = useState<(ModelTarget | null)[]>([null, null]);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    void loadCatalog();
  }, []);

  const pick = (index: number, next: ModelTarget | null) => {
    const effort = next ? pickEffort(findModel(catalog, next.provider, next.model)) : undefined;
    setTargets((current) => current.map((t, i) => (i === index ? (next ? { ...next, effort } : null) : t)));
  };

  const [first, second] = targets;
  const ready = brief.trim() !== "" && first !== null && second !== null && !busy && !starting;

  const start = async () => {
    if (!first || !second) return;
    setStarting(true);
    await startCompare(brief, [first, second]);
    setStarting(false);
  };

  return (
    <div className="wb-compare-setup" data-part="compare-setup">
      <textarea
        className="wb-search-input wb-compare-brief"
        aria-label="Brief"
        placeholder="What should both models do?"
        rows={4}
        maxLength={8000}
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <div className="wb-compare-pickers">
        <ModelPicker catalog={catalog} value={first} need="write" label="First model" onChange={(next) => pick(0, next)} />
        <ModelPicker catalog={catalog} value={second} need="write" label="Second model" onChange={(next) => pick(1, next)} />
      </div>
      <p className="faint small wb-compare-note">
        Each model works on its own copy of the project, uncommitted changes included. Nothing here changes until you keep one.
        Ignored files, like node_modules, aren't copied.
      </p>
      <div className="wb-compare-actions">
        <button type="button" className="wb-mini-btn" onClick={() => closeCompare()}>
          Close
        </button>
        <button
          type="button"
          className="wb-mini-btn primary"
          data-part="compare-start"
          disabled={!ready}
          title={busy ? "Wait for the turn to finish" : undefined}
          onClick={() => void start()}
        >
          Run both
        </button>
      </div>
    </div>
  );
}

function sideStatus(side: CompareSide): string {
  const seconds = side.elapsedMs === null ? "" : ` · ${Math.round(side.elapsedMs / 1000)}s`;
  switch (side.status) {
    case "running":
      return "Working…";
    case "done":
      return `${side.changed === 0 ? "No changes" : plural(side.changed ?? 0, "file")}${seconds}`;
    case "stopped":
      return "Stopped";
    default:
      return `Failed${seconds}`;
  }
}

function SideFile({ file }: { file: DiffFile }) {
  return (
    <div className="wb-compare-file">
      <div className="wb-viewer-head">
        <span className="wb-viewer-path" title={file.path}>
          {file.path}
        </span>
        <span className="spacer" />
        <span className="wb-diff-stats">
          {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
          {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
        </span>
      </div>
      {file.note && <div className="muted small wb-diff-note">{file.note}</div>}
      {file.hunks.map((hunk, h) => (
        <div key={h} className="wb-hunk-block">
          <div className="wb-hunk-header">{hunk.header}</div>
          <table className="wb-code-table wb-diff-table">
            <tbody>
              {hunk.lines.map((line, l) => (
                <tr key={l} className={`wb-diff-${line.type}`}>
                  <td className="wb-code-num">{line.newLine ?? line.oldLine ?? ""}</td>
                  <td className="wb-diff-sign">{line.type === "add" ? "+" : line.type === "del" ? "-" : " "}</td>
                  <td className="wb-code-line">{line.text || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function SideView({ side, index, busy, onKeep }: { side: CompareSide; index: number; busy: boolean; onKeep: () => void }) {
  const [files, setFiles] = useState<DiffFile[] | null>(null);

  useEffect(() => {
    if (side.status !== "done") return;
    let live = true;
    void loadCompareDiff(index).then((res) => {
      if (live && res) setFiles(res.files);
    });
    return () => {
      live = false;
    };
  }, [side.status, side.tree, index]);

  return (
    <section className="wb-compare-side" data-part="compare-side" data-status={side.status} aria-label={side.model}>
      <div className="wb-compare-side-head">
        <div className="wb-compare-side-title">
          <span className="wb-compare-model" title={side.provider}>
            {side.model}
            {side.effort ? ` · ${side.effort}` : ""}
          </span>
          <span className="faint small" data-part="compare-status">
            {sideStatus(side)}
          </span>
        </div>
        {side.status === "done" && side.changed !== 0 && (
          <button type="button" className="wb-mini-btn primary" data-part="compare-keep" disabled={busy} onClick={onKeep}>
            Keep
          </button>
        )}
      </div>
      {side.status === "failed" && <pre className="wb-compare-error">{side.detail}</pre>}
      <div className="wb-compare-files">{files?.map((file) => <SideFile key={file.path} file={file} />)}</div>
    </section>
  );
}

function CompareRun({ compare }: { compare: CompareState }) {
  const busy = useStore((s) => s.busy);
  const [working, setWorking] = useState(false);

  const keep = async (side: number) => {
    setWorking(true);
    await keepCompareSide(side);
    setWorking(false);
  };

  return (
    <div className="wb-compare" data-part="compare">
      <div className="wb-diff-toolbar">
        <span className="wb-compare-title" title={compare.brief}>
          {compare.brief}
        </span>
        <span className="spacer" />
        <button type="button" className="wb-mini-btn" data-part="compare-discard" disabled={working} onClick={() => void discardCompare()}>
          {compare.status === "running" ? "Stop" : "Discard"}
        </button>
      </div>
      <div className="wb-compare-sides">
        {compare.sides.map((side, index) => (
          <SideView key={index} side={side} index={index} busy={busy || working} onKeep={() => void keep(index)} />
        ))}
      </div>
    </div>
  );
}

export function CompareTab() {
  const compare = useStore((s) => s.compare);
  return compare ? <CompareRun compare={compare} /> : <CompareSetup />;
}
