/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Composer, EmptyState } from "./Composer";
import { Conversation } from "./Conversation";
import { IconClose } from "./icons";
import { PaneMark, type Side } from "./SessionTabs";
import { basename, modelDisplayName, sameDir } from "../lib";
import { PaneProvider, closePane, currentSessionTitle, focusPane, setSplitPaused, useFocusedPane, useStore } from "../store";

/** One chat: its transcript and composer, or the empty screen before its first turn. */
export function ChatColumn() {
  const empty = useStore((s) => s.messages.length === 0 && s.toolOrder.length === 0);
  return empty ? (
    <EmptyState />
  ) : (
    <>
      <Conversation />
      <Composer />
    </>
  );
}

/** Room for two readable columns, about 330px each. Below it split view pauses. */
const SPLIT_MIN_WIDTH = 680;

/**
 * Two sessions side by side. The focused pane's session is the one the
 * Workbench, the palette and the title bar act on; clicking or typing in the
 * other pane moves focus there first, so its buttons act on its own session.
 * When the chat column is too narrow for two readable columns, split view
 * pauses: only the focused pane shows, the other waits in its tab (still
 * running, its draft kept), and both come back once there's room again.
 */
export function SplitView({ left, right }: { left: string; right: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const paused = useStore((s) => s.splitPaused);
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => setSplitPaused(el.clientWidth < SPLIT_MIN_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      setSplitPaused(false);
    };
  }, []);
  return (
    // Keyed by session: a pane that takes another session starts fresh, its draft included.
    <div ref={frame} className="split-view" data-part="split-view" data-paused={paused}>
      <ProjectOf id={left}>
        {(leftProject) => (
          <ProjectOf id={right}>
            {(rightProject) => {
              // Name the project in the labels only when it tells the panes apart.
              const apart = !!leftProject && !!rightProject && !sameDir(leftProject, rightProject);
              return (
                <div className="split-panes">
                  <ChatPane key={left} id={left} side="left" showProject={apart} />
                  <div className="split-divider" data-part="split-divider" aria-hidden="true" />
                  <ChatPane key={right} id={right} side="right" showProject={apart} />
                </div>
              );
            }}
          </ProjectOf>
        )}
      </ProjectOf>
    </div>
  );
}

/** One pane's project folder, read through that pane's own view of the store. */
function ProjectOf({ id, children }: { id: string; children: (workspace: string | undefined) => ReactNode }) {
  return (
    <PaneProvider value={id}>
      <ProjectRead render={children} />
    </PaneProvider>
  );
}

function ProjectRead({ render }: { render: (workspace: string | undefined) => ReactNode }) {
  const workspace = useStore((s) => s.session?.workspace);
  return <>{render(workspace)}</>;
}

function ChatPane({ id, side, showProject }: { id: string; side: Side; showProject: boolean }) {
  return (
    <PaneProvider value={id}>
      <PaneBody id={id} side={side} showProject={showProject} />
    </PaneProvider>
  );
}

/**
 * A pane is a tank: an outline around its label, transcript and composer, the
 * label set into the top edge like a fieldset's legend. The label says which
 * is which: the same left/right mark its tab carries, the title, the lead model,
 * and the project when the two panes are in different ones.
 */
function PaneBody({ id, side, showProject }: { id: string; side: Side; showProject: boolean }) {
  const focused = useFocusedPane();
  const title = useStore(currentSessionTitle);
  const busy = useStore((s) => s.busy);
  const waiting = useStore((s) => s.approvals.length);
  const model = useStore((s) => s.session?.settings.orchestratorModel);
  const workspace = useStore((s) => s.session?.workspace);
  return (
    <section
      className="chat-pane"
      data-part="chat-pane"
      data-pane={id}
      data-focused={focused}
      aria-label={title}
      onPointerDownCapture={(e) => {
        // Closing a pane shouldn't bring it to the front on the way out.
        if (!(e.target as Element).closest("[data-pane-close]")) focusPane(id);
      }}
      onFocusCapture={(e) => {
        if (!(e.target as Element).closest("[data-pane-close]")) focusPane(id);
      }}
    >
      {/* A fieldset for its legend: the outline breaks around the label, and the gap stays see-through. */}
      <fieldset className="chat-pane-tank" data-part="chat-pane-tank" role="presentation">
        <legend className="chat-pane-head" data-part="chat-pane-head">
          {busy && <span className="session-tab-busy chat-pane-busy" aria-label="Working" title="Working" />}
          <PaneMark side={side} />
          <span className="chat-pane-title" title={title}>
            {title}
          </span>
          {model && (
            <span className="chat-pane-meta" data-part="chat-pane-model" title={`Lead: ${modelDisplayName(model)}`}>
              {modelDisplayName(model)}
            </span>
          )}
          {showProject && workspace && (
            <span className="chat-pane-meta" data-part="chat-pane-project" title={workspace}>
              {basename(workspace)}
            </span>
          )}
          {waiting > 0 && (
            <span className="wb-tab-badge" title="Approval waiting">
              {waiting}
            </span>
          )}
          <button
            type="button"
            className="wb-icon-btn chat-pane-close"
            data-pane-close
            aria-label="Close this pane"
            title="Close this pane (the session keeps its tab)"
            onClick={() => closePane(id)}
          >
            <IconClose />
          </button>
        </legend>
        <ChatColumn />
      </fieldset>
    </section>
  );
}
