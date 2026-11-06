import { closeSession, currentSessionTitle, newSession, switchSession, toggleSplit, useStore } from "../store";
import { IconClose, IconPlus } from "./icons";

type Side = "left" | "right";

/** Which split-view pane a session is showing in, if any. */
function sideOf(split: { left: string; right: string } | null, id: string): Side | null {
  if (!split) return null;
  if (split.left === id) return "left";
  return split.right === id ? "right" : null;
}

/** Two columns: the split view's own mark, for its toggle. */
const IconColumns = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.25" y="3" width="11.5" height="10" rx="1.75" />
    <path d="M8 3v10" />
  </svg>
);

/** A small window with the half this session fills: where it is on screen in split view. */
const PaneMark = ({ side }: { side: Side }) => (
  <svg className="session-tab-pane" viewBox="0 0 14 11" aria-hidden="true">
    <rect x="0.75" y="0.75" width="12.5" height="9.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <rect x={side === "left" ? 2.4 : 7.6} y="2.4" width="4" height="6.2" rx="1" fill="currentColor" />
  </svg>
);

/** The window's sessions, in the order they were opened. One session needs no tabs, so it shows none. */
export function SessionTabs() {
  const order = useStore((s) => s.sessionOrder);
  const background = useStore((s) => s.backgroundSessions);
  const session = useStore((s) => s.session);
  const title = useStore(currentSessionTitle);
  const busy = useStore((s) => s.busy);
  const waiting = useStore((s) => s.approvals.length);
  const split = useStore((s) => s.split);

  if (!session || background.length === 0) return null;

  const tabs = order.flatMap((id) => {
    if (id === session.id) return [{ id, title, busy, waiting, active: true }];
    const other = background.find((s) => s.id === id);
    return other ? [{ ...other, active: false }] : [];
  });

  return (
    <div className="session-tabs glass" role="tablist" aria-label="Sessions" data-part="session-tabs">
      {tabs.map((tab) => {
        const side = sideOf(split, tab.id);
        return (
          <div key={tab.id} className="session-tab" data-active={tab.active} data-pane-side={side ?? undefined} data-part="session-tab">
            <button
              type="button"
              role="tab"
              className="session-tab-select"
              aria-selected={tab.active}
              title={side ? `${tab.title} (in the ${side} pane)` : tab.title}
              onClick={() => switchSession(tab.id)}
            >
              {tab.busy && <span className="session-tab-busy" aria-label="Working" />}
              {side && <PaneMark side={side} />}
              <span className="session-tab-title">{tab.title}</span>
              {tab.waiting > 0 && (
                <span className="wb-tab-badge" title="Approval waiting">
                  {tab.waiting}
                </span>
              )}
            </button>
            <button
              type="button"
              className="wb-icon-btn session-tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={() => void closeSession(tab.id)}
            >
              <IconClose />
            </button>
          </div>
        );
      })}
      <button type="button" className="wb-icon-btn" aria-label="New session" title="New session" onClick={() => void newSession()}>
        <IconPlus />
      </button>
      <button
        type="button"
        className="wb-icon-btn session-tabs-split"
        data-part="split-toggle"
        aria-label="Split view"
        aria-pressed={split !== null}
        title={split ? "One session at a time (Ctrl+\\)" : "Two sessions side by side (Ctrl+\\)"}
        onClick={toggleSplit}
      >
        <IconColumns />
      </button>
    </div>
  );
}
