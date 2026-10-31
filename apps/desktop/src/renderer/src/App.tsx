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

import { useEffect, useLayoutEffect } from "react";
import { Toasts, TurnStatus, Welcome } from "./components/Chrome";
import { CommandPalette } from "./components/CommandPalette";
import { Composer, EmptyState } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Onboarding } from "./components/Onboarding";
import { ProviderSwitchModal } from "./components/ProviderSwitchModal";
import { SceneLayer } from "./components/SceneLayer";
import { hasOpenDialog } from "./components/settings/controls";
import { SessionTabs } from "./components/SessionTabs";
import { SettingsView } from "./components/settings/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { PopoutWorkbenchView, Workbench } from "./components/workbench/Workbench";
import { POPOUT_TAB, getState, openSettings, useStore, workbenchVisible } from "./store";
import { applyPrefs, applyUserTheme } from "./theme";

const isMac = window.kumo.app.platform === "darwin";

export function App() {
  const phase = useStore((s) => s.phase);
  const prefs = useStore((s) => s.prefs);
  const empty = useStore((s) => s.messages.length === 0 && s.toolOrder.length === 0);
  const showWorkbench = useStore(workbenchVisible);
  const settings = useStore((s) => s.view === "settings" && s.phase !== "loading");

  useEffect(() => {
    if (prefs) applyPrefs(prefs);
  }, [prefs]);

  const themes = useStore((s) => s.themes);
  const themeId = prefs?.theme ?? null;
  // Before paint: an approval never shows under a theme's stylesheet, even for a frame.
  const approvalWaiting = useStore((s) => s.approvals.length > 0);
  useLayoutEffect(() => {
    applyUserTheme(themes?.themes.find((t) => t.id === themeId) ?? null, approvalWaiting);
  }, [themes, themeId, approvalWaiting]);

  // Ctrl+, (Cmd+, on macOS) opens Settings from anywhere.
  useEffect(() => {
    if (POPOUT_TAB) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey || e.shiftKey || e.key !== ",") return;
      if (getState().phase === "loading" || hasOpenDialog()) return;
      e.preventDefault();
      openSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (POPOUT_TAB) {
    return (
      <>
        <SceneLayer />
        <div className="shell">
          <TitleBar popoutTab={POPOUT_TAB} />
          <div className="stage">
            <PopoutWorkbenchView tab={POPOUT_TAB} />
          </div>
        </div>
        <Toasts />
      </>
    );
  }

  const dock = prefs?.dock ?? "right";
  const workers = showWorkbench ? dock : null;

  // While Settings is open, the chat stays mounted under it, hidden and inert:
  // its scroll position, draft and Workers panel come back as they were.
  const covered = settings ? { "data-covered": true, inert: true } : {};

  return (
    <>
      <SceneLayer />
      <div className="shell">
        <TitleBar />
        <div className="stage">
          {phase === "onboarding" && (
            <div className="pane" {...covered}>
              <Onboarding />
            </div>
          )}
          {phase === "no-project" && (
            <div className="pane" {...covered}>
              <Welcome />
            </div>
          )}
          {phase === "ready" && (
            <div className="body" {...covered}>
              <Sidebar />
              <main className="main" data-part="chat">
                <SessionTabs />
                {empty ? (
                  <EmptyState />
                ) : (
                  <>
                    <Conversation />
                    <Composer />
                  </>
                )}
                {workers === "bottom" && <Workbench dock="bottom" />}
              </main>
              {workers === "right" && <Workbench dock="right" />}
            </div>
          )}
          {settings && <SettingsView />}
        </div>
      </div>
      {workers === "floating" && (
        <div className="floating-layer" {...covered}>
          <Workbench dock="floating" />
        </div>
      )}
      <CommandPalette />
      <Toasts />
      <TurnStatus />
      <ProviderSwitchModal />
    </>
  );
}
