import { useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { BUILTIN_ROLES, formatElapsed, roleLabel, toolLabel, useNow } from "../lib";
import { useStore } from "../store";
import type { State } from "../store";
import type { Prefs, ToolView } from "../types";

// ── panel state: the picked tab and the cards the user opened or closed, per chat ──

const ALL = "all";
const OTHER = "other";
const tabKeyOf = (role: string | null) => (role === null ? OTHER : `role:${role}`);

type PanelUi = { chat: string | null; tab: string; open: Record<string, boolean> };
const freshUi = (chat: string | null): PanelUi => ({ chat, tab: ALL, open: {} });

let ui: PanelUi = freshUi(null);
const uiListeners = new Set<() => void>();
function setUi(next: PanelUi): void {
  ui = next;
  for (const listener of uiListeners) listener();
}
/** Kept outside the component so it survives a dock switch; a different chat starts fresh. */
function usePanelUi(chat: string | null): PanelUi {
  const current = useSyncExternalStore(
    (cb) => {
      uiListeners.add(cb);
      return () => uiListeners.delete(cb);
    },
    () => ui
  );
  useEffect(() => {
    if (ui.chat !== chat) setUi(freshUi(chat));
  }, [chat]);
  return current.chat === chat ? current : freshUi(chat);
}
const pickTab = (chat: string | null, tab: string) => setUi({ ...(ui.chat === chat ? ui : freshUi(chat)), tab });
const toggleRun = (chat: string | null, toolId: string, open: boolean) => {
  const base = ui.chat === chat ? ui : freshUi(chat);
  setUi({ ...base, open: { ...base.open, [toolId]: open } });
};

// ── runs grouped by role ──

type Run = { id: string; role: string | null; status: ToolView["status"]; startedAt: number };
type Group = { key: string; role: string | null; label: string; runs: Run[]; activeSince: number | null };

/** Only what the tabs need, as a string, so streamed output doesn't redraw the whole panel. */
const runSummary = (s: State): string =>
  s.toolOrder
    .map((id) => {
      const t = s.tools[id];
      return t ? [id, t.role ?? "", t.status, t.startedAt].join("\t") : "";
    })
    .filter(Boolean)
    .join("\n");

function parseRuns(summary: string): Run[] {
  if (!summary) return [];
  return summary
    .split("\n")
    .map((line) => {
      const [id, role, status, startedAt] = line.split("\t");
      return { id, role: role || null, status: status as Run["status"], startedAt: Number(startedAt) };
    })
    .reverse(); // newest first
}

/** Built-in roles in their fixed order, then custom roles as they first ran, then the rest. */
function groupRuns(runs: Run[], custom: ReadonlyArray<{ id: string; name?: string }> | undefined): Group[] {
  const firstRun = [...runs].reverse();
  const customOrder = firstRun.map((r) => r.role).filter((role): role is string => role !== null);
  const rank = (role: string | null): number => {
    if (role === null) return Number.MAX_SAFE_INTEGER;
    const builtin = (BUILTIN_ROLES as readonly string[]).indexOf(role);
    return builtin !== -1 ? builtin : BUILTIN_ROLES.length + customOrder.indexOf(role);
  };
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const key = tabKeyOf(run.role);
    let group = groups.get(key);
    if (!group) {
      group = { key, role: run.role, label: roleLabel(run.role, custom), runs: [], activeSince: null };
      groups.set(key, group);
    }
    group.runs.push(run);
    if (run.status === "running") group.activeSince = Math.min(group.activeSince ?? run.startedAt, run.startedAt);
  }
  return [...groups.values()].sort((a, b) => rank(a.role) - rank(b.role));
}

// ── pieces ──

/** Marks which edges of a sideways-scrolling strip hide tabs (data-fade="start|end|both"). */
export function useEdgeFade(ref: { current: HTMLElement | null }): void {
  useLayoutEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const update = () => {
      const start = strip.scrollLeft > 1;
      const end = strip.scrollLeft < strip.scrollWidth - strip.clientWidth - 1;
      const fade = start && end ? "both" : start ? "start" : end ? "end" : "";
      if (strip.dataset.fade !== fade) strip.dataset.fade = fade;
    };
    update();
    strip.addEventListener("scroll", update, { passive: true });
    // Tabs grow as their timers tick; watch them as well as the strip.
    const resize = new ResizeObserver(update);
    resize.observe(strip);
    for (const tab of strip.children) resize.observe(tab);
    return () => {
      strip.removeEventListener("scroll", update);
      resize.disconnect();
    };
  });
}

const Chevron = () => (
  <svg className="worker-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Three dots rising and falling in turn; still under reduced motion. */
const Wave = () => (
  <span className="wave" aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);

type TabProps = {
  tabKey: string;
  role: string;
  label: string;
  count: number;
  activeSince: number | null;
  selected: boolean;
  ids: { tab: (key: string) => string; panel: string };
  onSelect: (key: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
};

function Tab({ tabKey, role, label, count, activeSince, selected, ids, onSelect, onKeyDown, buttonRef }: TabProps) {
  const active = activeSince !== null;
  const now = useNow(active);
  return (
    <button
      ref={buttonRef}
      type="button"
      role="tab"
      id={ids.tab(tabKey)}
      aria-selected={selected}
      aria-controls={ids.panel}
      tabIndex={selected ? 0 : -1}
      className="workers-tab"
      data-part="workers-tab"
      data-role={role}
      data-active={active}
      onClick={() => onSelect(tabKey)}
      onKeyDown={onKeyDown}
    >
      <span className="workers-tab-label">{label}</span>{" "}
      <span className="workers-tab-count">{count}</span>
      {active && (
        <>
          {" "}
          <Wave />
          <span className="sr-only">running</span>{" "}
          <span className="workers-tab-time">{formatElapsed(Math.max(0, now - activeSince))}</span>
        </>
      )}
    </button>
  );
}

function WorkerCard({ toolId, chat, open, roleChip }: { toolId: string; chat: string | null; open: boolean | undefined; roleChip: string | null }) {
  const tool = useStore((s) => s.tools[toolId]);
  const now = useNow(tool?.status === "running");
  const output = useRef<HTMLPreElement>(null);
  const bodyId = useId();
  // Running runs start open and finished ones closed, until the user picks.
  const expanded = open ?? tool?.status === "running";

  useLayoutEffect(() => {
    if (expanded && tool?.status === "running" && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [tool?.output, tool?.status, expanded]);

  if (!tool) return null;
  // A run restored from an older turn log has no recorded time: show none rather than "0s".
  const elapsed = tool.status !== "running" && !tool.elapsedMs ? "" : formatElapsed(tool.elapsedMs ?? now - tool.startedAt);
  return (
    <div className="worker-card" data-part="worker-card" data-status={tool.status} data-open={expanded}>
      <button
        type="button"
        className="worker-run-toggle"
        data-part="worker-run-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => toggleRun(chat, toolId, !expanded)}
      >
        <span className="worker-title">
          <span className={tool.status === "running" ? "dot pulse" : "dot"} />
          {roleChip && <span className="worker-role">{roleChip}</span>}
          {(!roleChip || tool.role === null) && <span className="tool-name">{toolLabel(tool.name)}</span>}
          <span className="tool-model">{tool.model ?? ""}</span>
          <span className="spacer" />
          <span className="tool-status">{tool.status === "failed" ? (elapsed ? `failed · ${elapsed}` : "failed") : elapsed}</span>
          <Chevron />
        </span>
        {!expanded && tool.task && <span className="worker-task-line">{tool.task}</span>}
      </button>
      {expanded && (
        <div className="worker-body" id={bodyId}>
          <div className="worker-task">{tool.task}</div>
          {tool.output && (
            <pre className="worker-output" ref={output}>
              {tool.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkersPanel({ dock }: { dock: Exclude<Prefs["dock"], "hidden"> }) {
  const summary = useStore(runSummary);
  const chat = useStore((s) => (s.session ? `${s.session.workspace}\n${s.session.chatId ?? ""}` : null));
  const custom = useStore((s) => s.session?.settings.roles?.custom);
  const panelUi = usePanelUi(chat);
  const idBase = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const strip = useRef<HTMLDivElement>(null);
  useEdgeFade(strip);

  const runs = useMemo(() => parseRuns(summary), [summary]);
  const groups = useMemo(() => groupRuns(runs, custom), [runs, custom]);
  const running = runs.filter((r) => r.status === "running").length;
  // A picked role that has no runs here (a new chat) falls back to All.
  const selected = groups.some((g) => g.key === panelUi.tab) ? panelUi.tab : ALL;
  const shown = selected === ALL ? runs : (groups.find((g) => g.key === selected)?.runs ?? []);

  // The picked tab stays in view, also after a dock switch.
  useLayoutEffect(() => {
    const tab = tabRefs.current.get(selected)?.getBoundingClientRect();
    const view = strip.current;
    if (!tab || !view) return;
    const edge = view.getBoundingClientRect();
    if (tab.left < edge.left) view.scrollLeft -= edge.left - tab.left + 28;
    else if (tab.right > edge.right) view.scrollLeft += tab.right - edge.right + 28;
  }, [selected, dock]);

  const ids = { tab: (key: string) => `${idBase}-tab-${key}`, panel: `${idBase}-panel` };
  const keys = [ALL, ...groups.map((g) => g.key)];
  const select = (key: string) => pickTab(chat, key);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = keys.indexOf(selected);
    const next =
      e.key === "ArrowRight" ? (at + 1) % keys.length
      : e.key === "ArrowLeft" ? (at - 1 + keys.length) % keys.length
      : e.key === "Home" ? 0
      : e.key === "End" ? keys.length - 1
      : -1;
    if (next === -1) return;
    e.preventDefault();
    select(keys[next]);
    tabRefs.current.get(keys[next])?.focus();
  };
  const refFor = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) tabRefs.current.set(key, el);
    else tabRefs.current.delete(key);
  };
  const labelOf = new Map(groups.map((g) => [g.key, g.label]));

  return (
    <div className="workers-embedded" data-dock={dock}>
      <div className="workers-head">
        {runs.length > 0 && <span className="muted small workers-state">{running ? `${running} running` : "idle"}</span>}
        {runs.length > 0 && (
          <div
            ref={strip}
            className="workers-tabs"
            data-part="workers-tabs"
            role="tablist"
            aria-label="Worker roles"
            // A plain wheel scrolls the strip sideways when it overflows.
            onWheel={(e) => {
              const strip = e.currentTarget;
              if (e.deltaY && strip.scrollWidth > strip.clientWidth) strip.scrollLeft += e.deltaY;
            }}
          >
            <Tab
              tabKey={ALL}
              role={ALL}
              label="All"
              count={runs.length}
              activeSince={null}
              selected={selected === ALL}
              ids={ids}
              onSelect={select}
              onKeyDown={onKeyDown}
              buttonRef={refFor(ALL)}
            />
            {groups.map((g) => (
              <Tab
                key={g.key}
                tabKey={g.key}
                role={g.role ?? OTHER}
                label={g.label}
                count={g.runs.length}
                activeSince={g.activeSince}
                selected={selected === g.key}
                ids={ids}
                onSelect={select}
                onKeyDown={onKeyDown}
                buttonRef={refFor(g.key)}
              />
            ))}
          </div>
        )}
      </div>
      {runs.length === 0 ? (
        <div className="workers-list">
          <p className="muted small">Workers show up here when the lead hands off a task.</p>
        </div>
      ) : (
        <div className="workers-list" role="tabpanel" id={ids.panel} aria-labelledby={ids.tab(selected)}>
          {shown.map((run) => (
            <WorkerCard
              key={run.id}
              toolId={run.id}
              chat={chat}
              open={panelUi.open[run.id]}
              roleChip={selected === ALL ? (labelOf.get(tabKeyOf(run.role)) ?? null) : null}
            />
          ))}
        </div>
      )}
    </div>
  );
}
