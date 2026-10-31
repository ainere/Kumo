import { closeSession, currentSessionTitle, newSession, switchSession, useStore } from "../store";
import { IconClose, IconPlus } from "./icons";

/** The window's sessions, in the order they were opened. One session needs no tabs, so it shows none. */
export function SessionTabs() {
  const order = useStore((s) => s.sessionOrder);
  const background = useStore((s) => s.backgroundSessions);
  const session = useStore((s) => s.session);
  const title = useStore(currentSessionTitle);
  const busy = useStore((s) => s.busy);
  const waiting = useStore((s) => s.approvals.length);

  if (!session || background.length === 0) return null;

  const tabs = order.flatMap((id) => {
    if (id === session.id) return [{ id, title, busy, waiting, active: true }];
    const other = background.find((s) => s.id === id);
    return other ? [{ ...other, active: false }] : [];
  });

  return (
    <div className="session-tabs glass" role="tablist" aria-label="Sessions" data-part="session-tabs">
      {tabs.map((tab) => (
        <div key={tab.id} className="session-tab" data-active={tab.active} data-part="session-tab">
          <button
            type="button"
            role="tab"
            className="session-tab-select"
            aria-selected={tab.active}
            title={tab.title}
            onClick={() => switchSession(tab.id)}
          >
            {tab.busy && <span className="session-tab-busy" aria-label="Working" />}
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
      ))}
      <button type="button" className="wb-icon-btn" aria-label="New session" title="New session" onClick={() => void newSession()}>
        <IconPlus />
      </button>
    </div>
  );
}
