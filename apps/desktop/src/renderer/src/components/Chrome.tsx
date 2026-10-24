import { dismissToast, pickAndOpenFolder, toast, useStore } from "../store";
import { IconClose, IconFolder } from "./icons";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast glass-strong" data-kind={t.kind}>
          <span>{t.text}</span>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <IconClose />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Tells screen readers when a turn starts and finishes, without reading the stream. */
export function TurnStatus() {
  const busy = useStore((s) => s.busy);
  const phase = useStore((s) => s.phase);
  return (
    <div className="sr-only" aria-live="polite">
      {phase === "ready" ? (busy ? "Working" : "Ready") : ""}
    </div>
  );
}

export function Welcome() {
  return (
    <div className="welcome">
      <div className="welcome-card glass-strong">
        <h1>Open a project to start</h1>
        <p className="muted">Kumo works inside a folder: the lead and its workers read and change the files there.</p>
        <button className="btn primary" onClick={() => void pickAndOpenFolder().catch((err: Error) => toast("error", err.message))}>
          <IconFolder /> Open folder…
        </button>
      </div>
    </div>
  );
}
