import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  closePopoutTab,
  getState,
  popoutWorkbenchTab,
  previewPrefs,
  setState,
  setWorkbenchTab,
  toggleWorkbenchSplit,
  useStore,
} from "../../store";
import type { Prefs, WorkbenchTab } from "../../types";
import { IconClose, IconPopOut, IconSplit } from "../icons";
import { WorkersPanel, useEdgeFade } from "../WorkersPanel";
import { BrowserTab } from "./BrowserTab";
import { DiffTab } from "./DiffTab";
import { FilesTab } from "./FilesTab";
import { PanelTab } from "./PanelTab";
import { PlanTab } from "./PlanTab";

// xterm is big and most sessions never open the Terminal tab.
const TerminalTab = lazy(() => import("./TerminalTab").then((m) => ({ default: m.TerminalTab })));

export const WORKBENCH_TAB_DEFS: ReadonlyArray<{ id: WorkbenchTab; label: string }> = [
  { id: "workers", label: "Workers" },
  { id: "files", label: "Files" },
  { id: "diff", label: "Diff" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
  { id: "plan", label: "Plan" },
];

const panelIdOf = (tab: WorkbenchTab): string | null => (tab.startsWith("panel:") ? tab.slice("panel:".length) : null);

export function workbenchTabLabel(tab: WorkbenchTab): string {
  const panelId = panelIdOf(tab);
  if (panelId) return getState().panels?.panels.find((p) => p.id === panelId)?.name ?? panelId;
  return WORKBENCH_TAB_DEFS.find((d) => d.id === tab)?.label ?? tab;
}

/** The built-in tabs, then the user's own panels. */
export function useWorkbenchTabs(): ReadonlyArray<{ id: WorkbenchTab; label: string }> {
  const panels = useStore((s) => s.panels);
  return useMemo(
    () => [
      ...WORKBENCH_TAB_DEFS,
      ...(panels?.panels ?? []).map((p): { id: WorkbenchTab; label: string } => ({ id: `panel:${p.id}`, label: p.name })),
    ],
    [panels]
  );
}

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 220;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 140;
// The sidebar, the shell's padding and gaps, and the narrowest chat that still reads.
const RESERVED_WIDTH = 656;
const RESERVED_HEIGHT = 320;
const RESIZE_STEP = 16;

const clampWidth = (width: number) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(960, window.innerWidth - RESERVED_WIDTH, width)));
const clampHeight = (height: number) =>
  Math.round(Math.max(MIN_HEIGHT, Math.min(640, window.innerHeight - RESERVED_HEIGHT, height)));

function WorkbenchPaneBody({
  tab,
  dock,
  poppedOut,
}: {
  tab: WorkbenchTab;
  dock: Exclude<Prefs["dock"], "hidden">;
  poppedOut: boolean;
}) {
  if (poppedOut) {
    return (
      <div className="wb-popped-notice" data-part="workbench-popped-out">
        <p className="muted small">{workbenchTabLabel(tab)} is open in its own window.</p>
        <div className="wb-popped-actions">
          <button type="button" className="wb-mini-btn" onClick={() => void popoutWorkbenchTab(tab)}>
            Show window
          </button>
          <button type="button" className="wb-mini-btn" onClick={() => void closePopoutTab(tab)}>
            Bring back
          </button>
        </div>
      </div>
    );
  }
  const panelId = panelIdOf(tab);
  if (panelId) return <PanelTab panelId={panelId} />;
  switch (tab) {
    case "workers":
      return <WorkersPanel dock={dock} />;
    case "files":
      return <FilesTab />;
    case "diff":
      return <DiffTab />;
    case "terminal":
      return (
        <Suspense fallback={null}>
          <TerminalTab />
        </Suspense>
      );
    case "browser":
      return <BrowserTab />;
    case "plan":
      return <PlanTab />;
    default:
      return null;
  }
}

export function PopoutWorkbenchView({ tab }: { tab: WorkbenchTab }) {
  const ready = useStore((s) => s.phase === "ready");

  // Each pop-out gets its own name in the taskbar.
  useEffect(() => {
    document.title = `kumo · ${workbenchTabLabel(tab)}`;
  }, [tab]);

  return (
    <div className="wb-popout-shell glass" data-part="workbench-popout-view" data-tab={tab}>
      {ready ? (
        <WorkbenchPaneBody tab={tab} dock="right" poppedOut={false} />
      ) : (
        <div className="wb-popped-notice">
          <p className="muted small">Open a project in the main window to use this tab.</p>
        </div>
      )}
    </div>
  );
}

function PopOutButton({ tab }: { tab: WorkbenchTab }) {
  return (
    <button
      type="button"
      className="wb-icon-btn"
      data-part="workbench-popout-button"
      aria-label={`Pop out ${workbenchTabLabel(tab)}`}
      title={`Pop out ${workbenchTabLabel(tab)} into its own window`}
      onClick={() => void popoutWorkbenchTab(tab)}
    >
      <IconPopOut />
    </button>
  );
}

function TabStrip({
  tabs,
  active,
  pane,
  label,
  badgeFor,
}: {
  tabs: ReadonlyArray<{ id: WorkbenchTab; label: string }>;
  active: WorkbenchTab;
  pane: "primary" | "split";
  label: string;
  badgeFor: (tab: WorkbenchTab) => number;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const popoutTabs = useStore((s) => s.popoutTabs);
  useEdgeFade(strip);

  // The active tab stays in view when the dock is too narrow for all of them.
  useLayoutEffect(() => {
    strip.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const at = tabs.findIndex((t) => t.id === active);
    const next =
      e.key === "ArrowRight" ? (at + 1) % tabs.length
      : e.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next === -1) return;
    e.preventDefault();
    setWorkbenchTab(tabs[next].id, pane);
    strip.current?.querySelector<HTMLElement>(`[data-tab="${tabs[next].id}"]`)?.focus();
  };

  return (
    <div
      ref={strip}
      className="wb-tab-strip"
      role="tablist"
      aria-label={label}
      // A plain wheel scrolls the strip sideways when it overflows.
      onWheel={(e) => {
        const el = e.currentTarget;
        if (e.deltaY && el.scrollWidth > el.clientWidth) el.scrollLeft += e.deltaY;
      }}
    >
      {tabs.map((t) => {
        const selected = active === t.id;
        const badge = badgeFor(t.id);
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="wb-tab-btn"
            data-part={pane === "primary" ? "workbench-tab" : "workbench-split-tab"}
            data-tab={t.id}
            data-active={selected}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => setWorkbenchTab(t.id, pane)}
            onKeyDown={onKeyDown}
          >
            <span>{t.label}</span>
            {badge > 0 && <span className="wb-tab-badge">{badge}</span>}
            {popoutTabs.includes(t.id) && (
              <span className="wb-tab-popped" title="Open in its own window">
                <IconPopOut />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Workbench({ dock }: { dock: Exclude<Prefs["dock"], "hidden"> }) {
  const prefs = useStore((s) => s.prefs);
  const popoutTabs = useStore((s) => s.popoutTabs);
  const diffCount = useStore((s) => s.workspaceDiff.length + s.approvals.length);
  const runningWorkers = useStore((s) =>
    s.toolOrder.reduce((acc, id) => (s.tools[id]?.status === "running" ? acc + 1 : acc), 0)
  );
  const openTasks = useStore((s) => s.planItems.filter((i) => !i.done).length);

  const tabs = useWorkbenchTabs();
  const panelsRead = useStore((s) => s.panels !== null);
  // A panel removed from its folder gives its place back.
  const known = (tab: WorkbenchTab) => !panelsRead || tabs.some((t) => t.id === tab);
  const savedTab: WorkbenchTab = prefs?.workbenchTab ?? "workers";
  const primaryTab: WorkbenchTab = known(savedTab) ? savedTab : "workers";
  const rawSplitTab = prefs?.workbenchSplitTab && known(prefs.workbenchSplitTab) ? prefs.workbenchSplitTab : null;
  const splitTab: WorkbenchTab | null =
    rawSplitTab && rawSplitTab !== primaryTab ? rawSplitTab : rawSplitTab ? (primaryTab === "files" ? "diff" : "files") : null;

  const width = prefs?.workbenchWidth ?? DEFAULT_WIDTH;
  const height = prefs?.workbenchHeight ?? DEFAULT_HEIGHT;
  const dragStart = useRef<{ pos: number; size: number } | null>(null);
  const horizontal = dock === "right";

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { pos: horizontal ? e.clientX : e.clientY, size: horizontal ? width : height };
    setState({ workbenchResizing: true });
  };

  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    const { pos, size } = dragStart.current;
    if (horizontal) previewPrefs({ workbenchWidth: clampWidth(size + pos - e.clientX) });
    else previewPrefs({ workbenchHeight: clampHeight(size + pos - e.clientY) });
  };

  const onResizeEnd = () => {
    dragStart.current = null;
    setState({ workbenchResizing: false });
  };

  const resizeBy = (delta: number) => {
    if (horizontal) previewPrefs({ workbenchWidth: clampWidth(width + delta) });
    else previewPrefs({ workbenchHeight: clampHeight(height + delta) });
  };

  const onResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = horizontal ? "ArrowLeft" : "ArrowUp";
    const shrink = horizontal ? "ArrowRight" : "ArrowDown";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    resizeBy(e.key === grow ? RESIZE_STEP : -RESIZE_STEP);
  };

  const badgeFor = (tab: WorkbenchTab): number => {
    if (tab === "workers") return runningWorkers;
    if (tab === "diff") return diffCount;
    if (tab === "plan") return openTasks;
    return 0;
  };

  const sizeStyle =
    dock === "right"
      ? { width: `${width}px`, flex: `0 0 ${width}px` }
      : dock === "bottom"
        ? { height: `${height}px`, flex: `0 0 ${height}px` }
        : undefined;

  return (
    <aside
      className="workers workbench glass"
      data-part="workers"
      data-workbench="true"
      data-dock={dock}
      data-split={Boolean(splitTab)}
      style={sizeStyle}
      aria-label="Workbench"
    >
      {dock !== "floating" && (
        <div
          className={`wb-resizer wb-resizer-${dock}`}
          data-part="workbench-resizer"
          role="separator"
          aria-orientation={horizontal ? "vertical" : "horizontal"}
          aria-label="Resize workbench"
          aria-valuenow={horizontal ? width : height}
          tabIndex={0}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onKeyDown={onResizeKey}
          onDoubleClick={() =>
            previewPrefs(horizontal ? { workbenchWidth: clampWidth(DEFAULT_WIDTH) } : { workbenchHeight: clampHeight(DEFAULT_HEIGHT) })
          }
          title="Drag to resize, double-click to reset"
        />
      )}

      <div className="wb-nav-bar" data-part="workbench-nav">
        <TabStrip
          tabs={tabs}
          active={primaryTab}
          pane="primary"
          label="Workbench panels"
          badgeFor={badgeFor}
        />
        <div className="wb-nav-actions">
          <button
            type="button"
            className="wb-icon-btn"
            data-part="workbench-split-toggle"
            aria-label={splitTab ? "Close split view" : "Split workbench"}
            aria-pressed={Boolean(splitTab)}
            title={splitTab ? "Close split view" : "Split workbench in two"}
            onClick={() => toggleWorkbenchSplit()}
          >
            <IconSplit />
          </button>
          <PopOutButton tab={primaryTab} />
        </div>
      </div>

      <div className="wb-panes" data-split={Boolean(splitTab)}>
        <div className="wb-pane" data-part="workbench-pane" data-pane="primary" data-tab={primaryTab}>
          <WorkbenchPaneBody tab={primaryTab} dock={dock} poppedOut={popoutTabs.includes(primaryTab)} />
        </div>

        {splitTab && (
          <div className="wb-pane wb-pane-split" data-part="workbench-pane" data-pane="split" data-tab={splitTab}>
            <div className="wb-split-head">
              <TabStrip
                tabs={tabs.filter((t) => t.id !== primaryTab)}
                active={splitTab}
                pane="split"
                label="Second workbench panel"
                badgeFor={badgeFor}
              />
              <div className="wb-nav-actions">
                <PopOutButton tab={splitTab} />
                <button
                  type="button"
                  className="wb-icon-btn"
                  aria-label="Close split pane"
                  title="Close split view"
                  onClick={() => toggleWorkbenchSplit()}
                >
                  <IconClose />
                </button>
              </div>
            </div>
            <WorkbenchPaneBody tab={splitTab} dock={dock} poppedOut={popoutTabs.includes(splitTab)} />
          </div>
        )}
      </div>
    </aside>
  );
}
