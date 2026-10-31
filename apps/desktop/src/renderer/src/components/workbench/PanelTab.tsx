import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import { useAppliedTheme } from "../../theme";
import type { KumoEvent } from "../../types";
import { feedEvent } from "../SceneLayer";

/**
 * A custom panel from the user's panels folder, in a frame sandboxed to scripts
 * only. It's told the theme and the same bare activity feed a scene gets, never
 * chat text, and nothing it says back is listened to.
 */
export function PanelTab({ panelId }: { panelId: string }) {
  const panel = useStore((s) => s.panels?.panels.find((p) => p.id === panelId));
  // A saved file reloads the frame.
  const revision = useStore((s) => s.panelsRevision);
  const { mode, accent } = useAppliedTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  const theme = useRef({ mode, accent });
  theme.current = { mode, accent };

  const post = (message: Record<string, unknown>) => {
    if (loaded.current) frame.current?.contentWindow?.postMessage({ ...message, kumo: 1 }, "*");
  };

  useEffect(() => post({ type: "theme", theme: { mode, accent } }), [mode, accent]);

  useEffect(
    () =>
      window.kumo.onEvent((raw) => {
        const event = feedEvent(raw as KumoEvent);
        if (event) post({ type: "event", event });
      }),
    []
  );

  if (!panel) return <div className="muted small wb-empty-note">This panel isn't in the panels folder any more.</div>;

  return (
    <div className="wb-panel" data-part="workbench-panel">
      {panel.error && <div className="muted small wb-diff-note">{panel.error}</div>}
      <iframe
        key={revision}
        ref={frame}
        className="wb-panel-frame"
        data-part="custom-panel"
        src={panel.src}
        sandbox="allow-scripts"
        title={panel.name}
        onLoad={() => {
          loaded.current = true;
          post({ type: "theme", theme: theme.current });
        }}
      />
    </div>
  );
}
