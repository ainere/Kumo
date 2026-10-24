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

export const PrefsSchema = z.object({
  mode: z.enum(["system", "light", "dark"]),
  scene: z.string().min(1).max(64),
  dock: z.enum(["right", "bottom", "floating", "hidden"]),
  glassBlur: z.number().int().min(0).max(40),
  glassOpacity: z.number().int().min(15).max(90),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  grid: z.boolean(),
  lastWorkspace: z.string().nullable(),
});

/** @typedef {z.infer<typeof PrefsSchema>} Prefs */

/** @type {Prefs} */
export const DEFAULT_PREFS = {
  mode: "system",
  scene: "clouds",
  dock: "right",
  glassBlur: 18,
  glassOpacity: 46,
  accent: null,
  grid: true,
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
    stored = JSON.parse(fs.readFileSync(prefsFile(), "utf-8"));
  } catch {
    /* none yet, or unreadable */
  }
  /** @type {Record<string, unknown>} */
  const out = { ...DEFAULT_PREFS };
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
