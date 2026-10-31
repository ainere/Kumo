import { useEffect, useState } from "react";
import { refreshPlan, savePlanItems, send, useStore } from "../../store";
import { IconClose } from "../icons";

export function PlanTab() {
  const session = useStore((s) => s.session);
  const items = useStore((s) => s.planItems);
  const busy = useStore((s) => s.busy);
  const [newTask, setNewTask] = useState("");

  useEffect(() => {
    if (session) void refreshPlan();
  }, [session?.workspace, session?.chatId]);

  const doneCount = items.filter((i) => i.done).length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;
  const nextTask = items.find((i) => !i.done);

  const toggleItem = (id: string) => {
    void savePlanItems(items.map((it) => (it.id === id ? { ...it, done: !it.done } : it)));
  };

  const removeItem = (id: string) => {
    void savePlanItems(items.filter((it) => it.id !== id));
  };

  const addItem = () => {
    const text = newTask.trim();
    if (!text) return;
    setNewTask("");
    const id = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    void savePlanItems([...items, { id, text, done: false, source: "user" }]);
  };

  return (
    <div className="wb-plan" data-part="workbench-plan">
      {items.length > 0 && (
        <div className="wb-plan-head">
          <span className="muted small">
            {doneCount} of {items.length} done
          </span>
          <span className="spacer" />
          {nextTask && (
            <button
              type="button"
              className="wb-mini-btn primary"
              disabled={busy}
              onClick={() => void send(`Please complete this plan task: ${nextTask.text}`)}
              title={busy ? "The lead is working on a turn" : `Send to the lead: ${nextTask.text}`}
            >
              Run next task
            </button>
          )}
        </div>
      )}

      {items.length > 0 && (
        <div className="wb-plan-progress" aria-hidden="true">
          <div className="wb-plan-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}

      <form
        className="wb-plan-add"
        onSubmit={(e) => {
          e.preventDefault();
          addItem();
        }}
      >
        <input
          type="text"
          className="wb-search-input"
          aria-label="Add plan item"
          placeholder="Add a task…"
          maxLength={500}
          value={newTask}
          onChange={(e) => setNewTask(e.target.value)}
        />
        <button type="submit" className="wb-mini-btn" disabled={!newTask.trim()}>
          Add
        </button>
      </form>

      {items.length === 0 ? (
        <div className="muted small wb-empty-note">
          Checklists the lead writes show up here, or add your own tasks above.
        </div>
      ) : (
        <ul className="wb-plan-list" aria-label="Plan tasks">
          {items.map((item) => (
            <li key={item.id} className="wb-plan-item" data-done={item.done} data-part="plan-item">
              <label className="wb-plan-label">
                <input type="checkbox" checked={item.done} onChange={() => toggleItem(item.id)} />
                <span className="wb-plan-text">{item.text}</span>
              </label>
              <button
                type="button"
                className="wb-icon-btn"
                aria-label={`Remove task ${item.text}`}
                onClick={() => removeItem(item.id)}
              >
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
