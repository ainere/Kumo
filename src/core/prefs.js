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

// @ts-check
/**
 * prefs.js — Desktop-only preferences, in `<KUMO_HOME>/desktop.json`.
 *
 * The look of the app (light or dark, background scene, glass, where the
 * Workers panel docks) and the last workspace. Engine settings — models,
 * safety mode — stay in config.json and each session's own settings.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { kumoHome, atomicWriteJson } from "../config/paths.js";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * Color overrides for one mode. A missing key keeps the theme's own value;
 * the accent is shared by both modes (`accent` below).
 */
const ModeColorsSchema = z
  .object({ ground: hex.optional(), text: hex.optional(), muted: hex.optional(), glass: hex.optional() })
  .strict();

export const WORKBENCH_TABS = /** @type {const} */ (["workers", "files", "diff", "terminal", "browser", "plan"]);
const WorkbenchTabSchema = z.enum(WORKBENCH_TABS);

export const PrefsSchema = z.object({
  mode: z.enum(["system", "light", "dark"]),
  scene: z.string().min(1).max(64),
  dock: z.enum(["right", "bottom", "floating", "hidden"]),
  /** The active tab in the primary workbench pane. */
  workbenchTab: WorkbenchTabSchema,
  /** The active tab in the secondary split pane; null when not split. */
  workbenchSplitTab: WorkbenchTabSchema.nullable(),
  /** Width in px of the right-docked workbench. */
  workbenchWidth: z.number().int().min(260).max(960),
  /** Height in px of the bottom-docked workbench. */
  workbenchHeight: z.number().int().min(140).max(640),
  glassBlur: z.number().int().min(0).max(40),
  glassOpacity: z.number().int().min(15).max(90),
  accent: hex.nullable(),
  /** Ground, text, muted and glass tint, per mode. */
  colors: z.object({ dark: ModeColorsSchema, light: ModeColorsSchema }).strict(),
  grid: z.boolean(),
  /** The scene's frame-rate cap. */
  sceneFps: z.number().int().min(10).max(60),
  /** On top of the OS settings, which always apply. */
  reduceTransparency: z.boolean(),
  reduceMotion: z.boolean(),
  /** Chimes when a turn finishes or needs approval. */
  sounds: z.boolean(),
  /** A Windows notification when a turn ends or an approval waits and no Kumo window is in front. */
  notifications: z.boolean(),
  soundVolume: z.number().int().min(0).max(100),
  errorToasts: z.boolean(),
  /** Where chats are exported: a folder inside the workspace, relative to it; null is the workspace itself. */
  exportDir: z.string().min(1).max(240).nullable(),
  /** The first-run wizard is done (or was skipped). */
  onboarded: z.boolean(),
  /** Don't ask before continuing a chat on another provider. */
  skipProviderSwitchWarning: z.boolean(),
  lastWorkspace: z.string().nullable(),
});

/** @typedef {z.infer<typeof PrefsSchema>} Prefs */

/** @type {Prefs} */
export const DEFAULT_PREFS = {
  mode: "system",
  scene: "clouds",
  dock: "right",
  workbenchTab: "workers",
  workbenchSplitTab: null,
  workbenchWidth: 420,
  workbenchHeight: 220,
  glassBlur: 18,
  glassOpacity: 46,
  accent: null,
  colors: { dark: {}, light: {} },
  grid: true,
  sceneFps: 60,
  reduceTransparency: false,
  reduceMotion: false,
  sounds: true,
  notifications: true,
  soundVolume: 50,
  errorToasts: true,
  exportDir: null,
  onboarded: false,
  skipProviderSwitchWarning: false,
  lastWorkspace: null,
};

function prefsFile() {
  return path.join(kumoHome(), "desktop.json");
}

/**
 * The saved preferences over the defaults. A value that no longer validates
 * falls back to its default instead of failing the whole file.
 *
 * @returns {Prefs}
 */
export function loadPrefs() {
  /** @type {Record<string, unknown>} */
  let stored = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), "utf-8"));
    // `null`, a number or a list parse fine but hold no preferences; the defaults
    // stand in, and the next savePrefs writes the file anew.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    /* none yet, or unreadable */
  }
  // A deep copy: `colors` is nested, and a caller that edits the result must not edit the defaults.
  /** @type {Record<string, unknown>} */
  const out = structuredClone(DEFAULT_PREFS);
  const shape = /** @type {Record<string, z.ZodType>} */ (PrefsSchema.shape);
  for (const [key, schema] of Object.entries(shape)) {
    if (key in stored && schema.safeParse(stored[key]).success) out[key] = stored[key];
  }
  return /** @type {Prefs} */ (out);
}

/**
 * Validate and save a partial update; returns the result.
 *
 * @param {Partial<Prefs>} patch
 * @returns {Prefs}
 */
export function savePrefs(patch) {
  const next = PrefsSchema.parse({ ...loadPrefs(), ...patch });
  atomicWriteJson(prefsFile(), next);
  return next;
}
