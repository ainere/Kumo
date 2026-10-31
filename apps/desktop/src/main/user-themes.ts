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
 * The user's theme packages, `<KUMO_HOME>/themes/<id>/`: a `theme.json` with a
 * name and each mode's colors, a `theme.css` restyling any `data-part`, or
 * both. Only Node modules here, so it can run (and be tested) outside Electron.
 *
 * The page's Content-Security-Policy applies to `theme.css` as to everything
 * else, so a theme can't reach the network; app.css keeps approvals out of its
 * reach too.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One mode's colors. Mirrors `ThemeColors` in the renderer's types.ts. */
export interface ThemeColors {
  ground?: string;
  text?: string;
  muted?: string;
  glass?: string;
  accent?: string;
}

/** One package. Mirrors `UserTheme` in the renderer's types.ts. */
export interface UserTheme {
  id: string;
  name: string;
  dark: ThemeColors;
  light: ThemeColors;
  css: string;
  /** Why part of it was left out (bad JSON, too large), else null. */
  error: string | null;
}

export interface ThemeList {
  dir: string;
  themes: UserTheme[];
}

const THEME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_KEYS = ["ground", "text", "muted", "glass", "accent"] as const;
const MAX_FILE_BYTES = 512 * 1024;
const WATCH_DEBOUNCE_MS = 150;

/** The same directory as src/config/paths.js kumoHome(). */
export function userThemesDir(): string {
  const override = process.env.KUMO_HOME;
  const home = override && override.trim() !== "" ? path.resolve(override) : path.join(os.homedir(), ".kumo");
  return path.join(home, "themes");
}

export function ensureUserThemesDir(): string {
  const dir = userThemesDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The file's text, null when there is none; a file too large to be a stylesheet throws. */
function readSmall(file: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${path.basename(file)} is over ${MAX_FILE_BYTES / 1024} KB.`);
  return fs.readFileSync(file, "utf-8");
}

/** The colors a value really gives: anything but a six-digit hex is left to the app's own. */
function readColors(value: unknown): ThemeColors {
  const colors: ThemeColors = {};
  if (!value || typeof value !== "object") return colors;
  for (const key of COLOR_KEYS) {
    const color = (value as Record<string, unknown>)[key];
    if (typeof color === "string" && HEX.test(color)) colors[key] = color;
  }
  return colors;
}

function readTheme(id: string, dir: string): UserTheme | null {
  const theme: UserTheme = { id, name: id, dark: {}, light: {}, css: "", error: null };
  let found = false;
  try {
    const json = readSmall(path.join(dir, "theme.json"));
    if (json !== null) {
      found = true;
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (typeof parsed.name === "string" && parsed.name.trim()) theme.name = parsed.name.trim().slice(0, 40);
      theme.dark = readColors(parsed.dark);
      theme.light = readColors(parsed.light);
    }
  } catch (err) {
    found = true;
    theme.error = `theme.json: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  }
  try {
    const css = readSmall(path.join(dir, "theme.css"));
    if (css !== null) {
      found = true;
      theme.css = css;
    }
  } catch (err) {
    found = true;
    theme.error ??= err instanceof Error ? err.message : String(err);
  }
  return found ? theme : null;
}

/** Every package in the themes folder, by name. A broken one still lists, with its error. */
export function listUserThemes(): ThemeList {
  const dir = ensureUserThemesDir();
  const themes: UserTheme[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !THEME_ID.test(entry.name)) continue;
    const theme = readTheme(entry.name, path.join(dir, entry.name));
    if (theme) themes.push(theme);
  }
  themes.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, themes };
}

/** Calls onChange (debounced) when anything in the themes folder changes. Returns a function that stops watching. */
export function watchUserThemes(onChange: () => void): () => void {
  let debounce: NodeJS.Timeout | null = null;
  const watcher = fs.watch(ensureUserThemesDir(), { persistent: false, recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, WATCH_DEBOUNCE_MS);
  });
  watcher.on("error", (err) => console.error("kumo: can't watch the themes folder:", err));
  return () => {
    if (debounce) clearTimeout(debounce);
    watcher.close();
  };
}
