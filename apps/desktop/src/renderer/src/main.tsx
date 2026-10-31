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

import "@fontsource-variable/manrope";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/workbench.css";
import "./theme";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { POPOUT_TAB, boot, bootPopout, getState, handleEvent, setState, toast } from "./store";
import type { KumoEvent } from "./types";

window.kumo.onEvent((event) => handleEvent(event as KumoEvent));

window.kumo.onEngineRestart(() => {
  // Sessions lived in the old engine. Chats are on disk; open the workspace
  // again in the new one. Requests the old engine never answered stay quiet
  // (ENGINE_RESTARTED) because this notice covers them.
  const turnLost = getState().busy;
  setState({ session: null, busy: false, tools: {}, toolOrder: [], approvals: [] });
  // A pop-out waits to hear which session the main window opened next.
  if (POPOUT_TAB) return;
  toast("warning", turnLost ? "The engine restarted, so the running turn was lost." : "The engine restarted.");
  void boot();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

void (POPOUT_TAB ? bootPopout() : boot());
