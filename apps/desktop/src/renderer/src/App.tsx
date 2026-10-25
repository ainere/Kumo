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

import { useEffect } from "react";
import { Toasts, TurnStatus, Welcome } from "./components/Chrome";
import { Composer, EmptyState } from "./components/Composer";
import { Conversation } from "./components/Conversation";
import { Onboarding } from "./components/Onboarding";
import { ProviderSwitchModal } from "./components/ProviderSwitchModal";
import { SceneLayer } from "./components/SceneLayer";
import { hasOpenDialog } from "./components/settings/controls";
import { SettingsView } from "./components/settings/SettingsView";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { WorkersPanel } from "./components/WorkersPanel";
import { getState, openSettings, useStore } from "./store";
import { applyPrefs } from "./theme";

const isMac = window.kumo.app.platform === "darwin";

export function App() {
  const phase = useStore((s) => s.phase);
  const prefs = useStore((s) => s.prefs);
  const empty = useStore((s) => s.messages.length === 0 && s.toolOrder.length === 0);
  const settings = useStore((s) => s.view === "settings" && s.phase !== "loading");

  useEffect(() => {
    if (prefs) applyPrefs(prefs);
  }, [prefs]);

  // Ctrl+, (Cmd+, on macOS) opens Settings from anywhere.
  useEffect(() => {
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

  const dock = prefs?.dock ?? "right";
  const workers = phase === "ready" && !empty && dock !== "hidden" ? dock : null;

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
                {empty ? (
                  <EmptyState />
                ) : (
                  <>
                    <Conversation />
                    <Composer />
                  </>
                )}
                {workers === "bottom" && <WorkersPanel dock="bottom" />}
              </main>
              {workers === "right" && <WorkersPanel dock="right" />}
            </div>
          )}
          {settings && <SettingsView />}
        </div>
      </div>
      {workers === "floating" && (
        <div className="floating-layer" {...covered}>
          <WorkersPanel dock="floating" />
        </div>
      )}
      <Toasts />
      <TurnStatus />
      <ProviderSwitchModal />
    </>
  );
}
