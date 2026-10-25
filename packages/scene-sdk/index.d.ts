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
 * single frame when reduced motion is on (the OS setting, or the app's own).
 * The app may cap the frame rate (10-60 fps): update() still gets the same
 * fixed 60 Hz steps, frame() and render() just run less often. The gallery
 * mounts scenes at thumbnail size, at 24 fps at most and with the grid off, so
 * size everything from ctx.width and ctx.height.
 *
 * Put a scene in `<KUMO_HOME>/scenes/` (`~/.kumo/scenes/`) as a `.js` or `.ts`
 * file; the app reloads it when you save. A scene is ONE CLASSIC SCRIPT:
 *
 *   - There is no bundler and no module loading, so no `import` or `export`.
 *     The only imports allowed are type-only ones, which are removed before
 *     the scene runs: `import type { SceneContext } from "@kumo/scene-sdk";`.
 *     (`import { type X } from ...` is not removed entirely; use `import type`.)
 *   - TypeScript is compiled by stripping types, nothing more: no `enum`
 *     (use a const object), no `namespace`, no constructor parameter
 *     properties. A syntax or unsupported-syntax error is shown on the scene's
 *     card in Settings and the scene isn't loaded.
 *   - All scene files share one global scope, so wrap yours in a function
 *     (an IIFE) to keep a top-level `const` from clashing with another file's.
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
  /** The app's own reduced-motion setting; on, the scene gets one still frame, as with the OS setting. */
  reducedMotion?: boolean;
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
  /** True when the OS or the app asks for reduced motion: the runtime draws a single frame. */
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
