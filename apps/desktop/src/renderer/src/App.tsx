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
