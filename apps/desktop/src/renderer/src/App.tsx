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
import { SceneLayer } from "./components/SceneLayer";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { WorkersPanel } from "./components/WorkersPanel";
import { useStore } from "./store";
import { applyPrefs } from "./theme";

export function App() {
  const phase = useStore((s) => s.phase);
  const prefs = useStore((s) => s.prefs);
  const empty = useStore((s) => s.messages.length === 0 && s.toolOrder.length === 0);

  useEffect(() => {
    if (prefs) applyPrefs(prefs);
  }, [prefs]);

  const dock = prefs?.dock ?? "right";
  const workers = phase === "ready" && !empty && dock !== "hidden" ? dock : null;

  return (
    <>
      <SceneLayer />
      <div className="shell">
        <TitleBar />
        {phase === "no-project" && <Welcome />}
        {phase === "ready" && (
          <div className="body">
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
      </div>
      {workers === "floating" && <WorkersPanel dock="floating" />}
      <Toasts />
      <TurnStatus />
    </>
  );
}
