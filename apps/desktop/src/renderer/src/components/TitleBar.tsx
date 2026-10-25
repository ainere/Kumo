import { useEffect, useState } from "react";
import { basename } from "../lib";
import { closeSettings, openSettings, savePrefs, useStore } from "../store";
import { useAppliedTheme } from "../theme";
import { IconGear, IconMoon, IconSun } from "./icons";
import { settingsTabLabel } from "./settings/SettingsView";

const isMac = window.kumo.app.platform === "darwin";

/**
 * Close, minimize and maximize as round buttons in the title bar, colored by
 * the theme status tokens (--win-close, --win-min, --win-max).
 */
function WindowControls() {
  const [state, setState] = useState({ maximized: false, focused: true });
  useEffect(() => {
    void window.kumo.app.window("state").then(setState);
    return window.kumo.app.onWindowState(setState);
  }, []);

  if (isMac) return null;
  return (
    <div className="window-controls no-drag" data-part="window-controls" data-focused={state.focused}>
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
      <button className="win-btn close" aria-label="Close" onClick={() => void window.kumo.app.window("close")}>
        <svg viewBox="0 0 14 14" aria-hidden="true">
          <path d="M4.75 4.75l4.5 4.5M9.25 4.75l-4.5 4.5" />
        </svg>
      </button>
    </div>
  );
}

export function TitleBar() {
  const phase = useStore((s) => s.phase);
  const session = useStore((s) => s.session);
  const chats = useStore((s) => s.chats);
  const settings = useStore((s) => s.view === "settings" && s.phase !== "loading");
  const tab = useStore((s) => s.settingsTab);
  const appliedTheme = useAppliedTheme();
  const chat = session ? chats.find((c) => c.id === session.chatId) : undefined;

  const toggleTheme = () => {
    const nextMode = appliedTheme.mode === "dark" ? "light" : "dark";
    void savePrefs({ mode: nextMode });
  };

  return (
    <header className="titlebar glass" data-part="titlebar">
      {isMac && <div className="window-controls-space" aria-hidden="true" />}
      <span className="brand">kumo</span>
      <span className="brand-kanji">雲</span>
      {settings ? (
        <>
          <span className="divider-v" />
          <nav className="crumb crumbs" aria-label="Breadcrumb">
            <span>Settings</span>
            <span className="crumb-sep" aria-hidden="true">
              ›
            </span>
            <span className="crumb-current" aria-current="page">
              {settingsTabLabel(tab)}
            </span>
          </nav>
        </>
      ) : (
        session && (
          <>
            <span className="divider-v" />
            <span className="crumb">
              {basename(session.workspace)}
              {chat ? ` / ${chat.title}` : ""}
            </span>
          </>
        )
      )}
      <span className="spacer" />
      {phase !== "loading" && (
        <>
          <button
            type="button"
            className="icon-btn"
            data-part="theme-toggle"
            aria-label={`Switch to ${appliedTheme.mode === "dark" ? "light" : "dark"} mode`}
            data-tooltip={appliedTheme.mode === "dark" ? "Light mode" : "Dark mode"}
            data-tooltip-pos="bottom"
            onClick={toggleTheme}
          >
            {appliedTheme.mode === "dark" ? <IconSun /> : <IconMoon />}
          </button>
          <button
            type="button"
            className="icon-btn"
            data-part="settings-button"
            aria-label="Settings"
            aria-pressed={settings}
            data-tooltip={`Settings (${isMac ? "⌘," : "Ctrl+,"})`}
            data-tooltip-pos="bottom"
            onClick={() => (settings ? closeSettings() : openSettings())}
          >
            <IconGear />
          </button>
        </>
      )}
      {!isMac && <WindowControls />}
    </header>
  );
}
