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

import { Composer, EmptyState } from "./Composer";
import { Conversation } from "./Conversation";
import { IconClose } from "./icons";
import { PaneProvider, closePane, currentSessionTitle, focusPane, useFocusedPane, useStore } from "../store";

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

/**
 * Two sessions side by side. The focused pane's session is the one the
 * Workbench, the palette and the title bar act on; clicking or typing in the
 * other pane moves focus there first, so its buttons act on its own session.
 * When the chat column is too tight for two readable columns, they stack (see app.css).
 */
export function SplitView({ left, right }: { left: string; right: string }) {
  return (
    // Keyed by session: a pane that takes another session starts fresh, its draft included.
    <div className="split-view" data-part="split-view">
      <div className="split-panes">
        <ChatPane key={left} id={left} />
        <div className="split-divider" data-part="split-divider" aria-hidden="true" />
        <ChatPane key={right} id={right} />
      </div>
    </div>
  );
}

function ChatPane({ id }: { id: string }) {
  return (
    <PaneProvider value={id}>
      <PaneBody id={id} />
    </PaneProvider>
  );
}

function PaneBody({ id }: { id: string }) {
  const focused = useFocusedPane();
  const title = useStore(currentSessionTitle);
  const busy = useStore((s) => s.busy);
  const waiting = useStore((s) => s.approvals.length);
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
      <header className="chat-pane-head glass" data-part="chat-pane-head">
        {busy && <span className="session-tab-busy chat-pane-busy" aria-label="Working" title="Working" />}
        <span className="chat-pane-title" title={title}>
          {title}
        </span>
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
      </header>
      <ChatColumn />
    </section>
  );
}
