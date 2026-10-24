import { useEffect, useRef, useState } from "react";
import { basename } from "../lib";
import { newChat, useStore } from "../store";
import { AppearanceMenu } from "./AppearanceMenu";
import { IconPlus, IconSliders } from "./icons";

/**
 * Close, minimize and maximize as round buttons in the title bar, colored by
 * the theme (--win-close, --win-min, --win-max). macOS draws its own traffic
 * lights in the same spot, so there this only leaves room for them.
 */
function WindowControls() {
  const [state, setState] = useState({ maximized: false, focused: true });
  useEffect(() => {
    void window.kumo.app.window("state").then(setState);
    return window.kumo.app.onWindowState(setState);
  }, []);

  if (window.kumo.app.platform === "darwin") return <div className="window-controls-space" aria-hidden="true" />;
  return (
    <div className="window-controls no-drag" data-part="window-controls" data-focused={state.focused}>
      <button className="win-btn close" aria-label="Close" onClick={() => void window.kumo.app.window("close")}>
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M4.75 4.75l4.5 4.5M9.25 4.75l-4.5 4.5" />
        </svg>
      </button>
      <button className="win-btn min" aria-label="Minimize" onClick={() => void window.kumo.app.window("minimize")}>
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M4.25 7h5.5" />
        </svg>
      </button>
      <button
        className="win-btn max"
        aria-label={state.maximized ? "Restore" : "Maximize"}
        onClick={() => void window.kumo.app.window("toggleMaximize")}
      >
        <svg viewBox="0 0 14 14" aria-hidden="true">
          {state.maximized ? (
            <path d="M4.5 9.5V7M4.5 9.5H7M9.5 4.5V7M9.5 4.5H7" />
          ) : (
            <path d="M7 4.25v5.5M4.25 7h5.5" />
          )}
        </svg>
      </button>
    </div>
  );
}

export function TitleBar() {
  const session = useStore((s) => s.session);
  const chats = useStore((s) => s.chats);
  const busy = useStore((s) => s.busy);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const chat = session ? chats.find((c) => c.id === session.chatId) : undefined;

  return (
    <header className="titlebar glass" data-part="titlebar">
      <WindowControls />
      <span className="brand">kumo</span>
      <span className="brand-kanji">雲</span>
      {session && (
        <>
          <span className="divider-v" />
          <span className="crumb" title={session.workspace}>
            {basename(session.workspace)}
            {chat ? ` / ${chat.title}` : ""}
          </span>
        </>
      )}
      <span className="spacer" />
      {session && (
        <button className="chip-btn" onClick={() => void newChat()} disabled={busy}>
          <IconPlus /> New chat
        </button>
      )}
      <button
        ref={menuButton}
        className="icon-btn"
        aria-label="Appearance"
        aria-expanded={menu}
        onClick={() => setMenu((open) => !open)}
      >
        <IconSliders />
      </button>
      {menu && <AppearanceMenu anchor={menuButton.current} onClose={() => setMenu(false)} />}
    </header>
  );
}
