/**
 * @kumo/scene-sdk: types for Kumo background scenes.
 *
 * A scene runs in a sandboxed iframe behind the window's glass: an opaque
 * origin with no network, no Node and no access to the window. It draws on a
 * canvas the runtime owns and reacts to a filtered activity feed (event
 * types, tool names and models; never prompt or response text).
 *
 *   defineScene({
 *     id: "my-scene",
 *     name: "My scene",
 *     mount(ctx) {
 *       return { frame(dt) { ctx.g.fillRect(0, 0, 10, 10); } };
 *     },
 *   });
 *
 * Each frame the runtime clears the canvas (and draws the grid when it's on)
 * before calling the scene. It pauses while the window is hidden and draws a
 * single frame when the OS asks for reduced motion.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where things are on screen, in CSS pixels; the scene canvas covers the window. */
export interface SceneLayout {
  workers: Rect | null;
  composer: Rect | null;
}

export interface SceneTheme {
  mode: "dark" | "light";
  grid: boolean;
  /** The accent color as a CSS color string. */
  accent: string;
}

export type SceneEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "turn.completed"; turnId: string }
  | { type: "turn.failed"; turnId: string }
  | { type: "tool.started"; toolId: string; name: string; model: string | null }
  | { type: "tool.completed"; toolId: string; name: string; ok: boolean; elapsedMs: number }
  | { type: "approval.requested"; kind: "write" | "orchestrator" }
  | { type: "approval.resolved"; approved: boolean }
  | { type: "theme"; theme: SceneTheme }
  | { type: "layout"; layout: SceneLayout };

export interface SceneContext {
  readonly canvas: HTMLCanvasElement;
  /** The 2D context, already scaled for the device pixel ratio (capped at 2). */
  readonly g: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly theme: SceneTheme;
  readonly layout: SceneLayout;
  /** Workers running right now. */
  readonly running: number;
  readonly reducedMotion: boolean;
  /** The point activity gathers toward: the Workers panel, else the composer, else the middle. */
  target(): [x: number, y: number];
  /** A seeded random generator, for scenes that should look the same every launch. */
  random(seed: number): () => number;
}

export interface SceneInstance {
  resize?(width: number, height: number, dpr: number): void;
  /** Fixed 60 Hz step for simulation; called 0–4 times per frame. */
  update?(step: number): void;
  /** Once per frame, with the seconds since the last one (at most 0.1). */
  frame?(dt: number): void;
  /** Once per frame, after update() and frame(). */
  render?(): void;
  onEvent?(event: SceneEvent): void;
  dispose?(): void;
}

export interface SceneDefinition {
  id: string;
  name: string;
  mount(ctx: SceneContext): SceneInstance | void;
}

declare global {
  function defineScene(definition: SceneDefinition): SceneDefinition;
}

export {};
