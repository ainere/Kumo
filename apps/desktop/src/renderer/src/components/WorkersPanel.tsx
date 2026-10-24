import { useLayoutEffect, useRef } from "react";
import { formatElapsed, toolLabel, useNow } from "../lib";
import { useStore } from "../store";
import type { Prefs } from "../types";

function WorkerCard({ toolId }: { toolId: string }) {
  const tool = useStore((s) => s.tools[toolId]);
  const now = useNow(tool?.status === "running");
  const output = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    if (tool?.status === "running" && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [tool?.output, tool?.status]);

  if (!tool) return null;
  const elapsed = formatElapsed(tool.elapsedMs ?? now - tool.startedAt);
  return (
    <div className="worker-card" data-part="worker-card" data-status={tool.status}>
      <div className="worker-title">
        <span className={tool.status === "running" ? "dot pulse" : "dot"} />
        <span className="tool-name">{toolLabel(tool.name)}</span>
        <span className="tool-model">{tool.model ?? ""}</span>
        <span className="spacer" />
        <span className="tool-status">{tool.status === "failed" ? `failed · ${elapsed}` : elapsed}</span>
      </div>
      <div className="worker-task">{tool.task}</div>
      {tool.output && (
        <pre className="worker-output" ref={output}>
          {tool.output}
        </pre>
      )}
    </div>
  );
}

export function WorkersPanel({ dock }: { dock: Exclude<Prefs["dock"], "hidden"> }) {
  const order = useStore((s) => s.toolOrder);
  const running = useStore((s) => s.toolOrder.filter((id) => s.tools[id]?.status === "running").length);
  return (
    <aside className="workers glass" data-part="workers" data-dock={dock} aria-label="Workers">
      <div className="workers-head">
        <span>Workers</span>
        <span className="muted small">{running ? `${running} running` : order.length ? "idle" : ""}</span>
      </div>
      <div className="workers-list">
        {order.length === 0 ? (
          <p className="muted small">Workers show up here when the lead hands off a task.</p>
        ) : (
          [...order].reverse().map((id) => <WorkerCard key={id} toolId={id} />)
        )}
      </div>
    </aside>
  );
}
