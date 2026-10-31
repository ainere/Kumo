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
 * theme.js — `kumo theme new`: start a desktop theme package to edit.
 */

import fs from "node:fs";
import path from "node:path";
import { kumoHome } from "../config/paths.js";

const STARTER_CSS = `/*
 * Kumo restyles as you save. Everything in the window is a CSS variable or a
 * [data-part] you can target, for example:
 *
 *   [data-part="sidebar"]  [data-part="composer"]  [data-part="workers"]
 *   [data-part="message-user"]  [data-part="message-lead"]  [data-part="tool-card"]
 *   [data-part="workbench-tab"]  [data-part="command-palette"]
 *
 * Variables worth starting with: --radius-panel, --glass-blur, --font-ui,
 * --font-mono, --border, --selected.
 *
 * A theme can't reach the network, and approvals keep their look so what they
 * ask stays readable.
 */

:root {
  --radius-panel: 16px;
}
`;

/**
 * The package's folder name, from what the user typed: "Deep Sea" is deep-sea.
 *
 * @param {string} name
 * @returns {string}
 */
export function themeId(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Create `<KUMO_HOME>/themes/<id>/` with a starter `theme.json` and `theme.css`.
 *
 * @param {string} name
 * @returns {string} the new folder
 */
export function createTheme(name) {
  const id = themeId(name);
  if (!id) throw new Error(`"${name}" has no letters or digits to name a theme with.`);
  const dir = path.join(kumoHome(), "themes", id);
  if (fs.existsSync(dir)) throw new Error(`A theme is already at ${dir}.`);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: String(name).trim().slice(0, 40),
    dark: { accent: "#5fd4f4" },
    light: { accent: "#2f6feb" },
  };
  fs.writeFileSync(path.join(dir, "theme.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "theme.css"), STARTER_CSS);
  return dir;
}

/** @param {string} name */
export function themeNewCommand(name) {
  const dir = createTheme(name);
  console.log(`Created ${dir}`);
  console.log("Pick it in the desktop app under Settings › Appearance; it reloads as you save.");
}
