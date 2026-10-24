import "@fontsource-variable/manrope";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./theme";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { boot, handleEvent, setState, toast } from "./store";
import type { KumoEvent } from "./types";

window.kumo.onEvent((event) => handleEvent(event as KumoEvent));

window.kumo.onEngineRestart(() => {
  // Sessions lived in the old engine. Chats are on disk; open the workspace
  // again in the new one.
  setState({ session: null, busy: false, tools: {}, toolOrder: [], approvals: [] });
  toast("warning", "The engine restarted, so the running turn was lost.");
  void boot();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

void boot();
