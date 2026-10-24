/**
 * The background scene: a sandboxed iframe on kumo-scene:// behind the glass
 * (see src/main/scene-protocol.ts). It's told the theme, where the Workers
 * panel and composer sit, and a filtered activity feed: event types, tool
 * names and models, never prompt or response text.
 */

import { useEffect, useRef } from "react";
import { setState, toast, useStore } from "../store";
import { useResolvedMode } from "../theme";
import type { KumoEvent } from "../types";

const SCENE_URL = "kumo-scene://scene/";

type Rect = { x: number; y: number; w: number; h: number };
type Layout = { workers: Rect | null; composer: Rect | null };
type Theme = { mode: "dark" | "light"; grid: boolean; accent: string };

function feedEvent(e: KumoEvent): Record<string, unknown> | null {
  switch (e.type) {
    case "turn.started":
    case "turn.completed":
    case "turn.failed":
      return { type: e.type, turnId: e.turnId };
    case "tool.started":
      return { type: e.type, toolId: e.toolId, name: e.name, model: e.model };
    case "tool.completed":
      return { type: e.type, toolId: e.toolId, name: e.name, ok: e.ok, elapsedMs: e.elapsedMs };
    case "approval.requested":
      return { type: e.type, kind: e.kind };
    case "approval.resolved":
      return { type: e.type, approved: e.approved };
    default:
      return null;
  }
}

function rectOf(part: string): Rect | null {
  const el = document.querySelector(`[data-part="${part}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width && r.height ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
}

const measure = (): Layout => ({ workers: rectOf("workers"), composer: rectOf("composer") });

export function SceneLayer() {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const scene = useStore((s) => s.prefs?.scene ?? "clouds");
  const grid = useStore((s) => s.prefs?.grid ?? true);
  const mode = useResolvedMode();

  const theme = (): Theme => ({
    mode,
    grid,
    accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  });
  const latest = useRef({ scene, theme });
  latest.current = { scene, theme };

  const post = (message: Record<string, unknown>) => {
    if (ready.current) frame.current?.contentWindow?.postMessage({ ...message, kumo: 1 }, "*");
  };

  useEffect(() => {
    let lastError = 0;
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || m.kumo !== 1 || typeof m.type !== "string") return;
      if (m.type === "ready") {
        ready.current = true;
        const scenes = Array.isArray(m.scenes) ? m.scenes : [];
        setState({
          scenes: scenes
            .filter((s): s is { id: string; name: string } => typeof s?.id === "string" && typeof s?.name === "string")
            .map((s) => ({ id: s.id.slice(0, 64), name: s.name.slice(0, 40) })),
        });
        post({ type: "init", scene: latest.current.scene, theme: latest.current.theme(), layout: measure() });
        document.documentElement.dataset.scene = "ready";
      } else if (m.type === "error" && Date.now() - lastError > 10_000) {
        lastError = Date.now();
        toast("warning", `The background scene hit an error: ${String(m.message).slice(0, 200)}`);
      } else if (m.type === "stats" && typeof m.avgMs === "number") {
        frame.current.dataset.frameMs = m.avgMs.toFixed(2);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => post({ type: "scene", scene }), [scene]);
  useEffect(() => post({ type: "theme", theme: theme() }), [mode, grid]);

  // Panels appear, dock and resize; a cheap poll catches all of it.
  useEffect(() => {
    let last = "";
    const timer = setInterval(() => {
      const layout = measure();
      const key = JSON.stringify(layout);
      if (key !== last && ready.current) {
        last = key;
        post({ type: "layout", layout });
      }
    }, 400);
    return () => clearInterval(timer);
  }, []);

  useEffect(
    () =>
      window.kumo.onEvent((raw) => {
        const event = feedEvent(raw as KumoEvent);
        if (event) post({ type: "event", event });
      }),
    []
  );

  return (
    <iframe
      ref={frame}
      className="scene-layer"
      data-part="scene"
      src={SCENE_URL}
      sandbox="allow-scripts"
      title="Background scene"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
