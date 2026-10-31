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
 * panel.js — `kumo panel new`: start a desktop custom panel to edit.
 */

import fs from "node:fs";
import path from "node:path";
import { kumoHome } from "../config/paths.js";
import { themeId } from "./theme.js";

/** @param {string} name */
const starterPage = (name) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 12px; font: 13px system-ui, sans-serif; }
  li { margin: 2px 0; }
</style>
</head>
<body>
<h3>${name.replace(/[<>&]/g, "")}</h3>
<ul id="log"></ul>
<script>
  // Kumo sends two kinds of message. "theme" has { mode, accent }, and "event" has
  // what's happening: turn.started, tool.started, approval.requested and so on,
  // never the text of a chat. A panel has no network and can't reach the app.
  addEventListener("message", ({ data }) => {
    if (data?.kumo !== 1) return;
    if (data.type === "theme") {
      document.body.style.color = data.theme.mode === "dark" ? "#e6ecf5" : "#0e1626";
      document.querySelector("h3").style.color = data.theme.accent;
    } else if (data.type === "event") {
      const item = document.createElement("li");
      item.textContent = data.event.type;
      document.getElementById("log").prepend(item);
    }
  });
</script>
</body>
</html>
`;

/**
 * Create \`<KUMO_HOME>/panels/<id>/\` with a starter page and name.
 *
 * @param {string} name
 * @returns {string} the new folder
 */
export function createPanel(name) {
  const id = themeId(name);
  if (!id) throw new Error(`"${name}" has no letters or digits to name a panel with.`);
  const dir = path.join(kumoHome(), "panels", id);
  if (fs.existsSync(dir)) throw new Error(`A panel is already at ${dir}.`);
  fs.mkdirSync(dir, { recursive: true });
  const title = String(name).trim().slice(0, 24);
  fs.writeFileSync(path.join(dir, "panel.json"), `${JSON.stringify({ name: title }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "panel.html"), starterPage(title));
  return dir;
}

/** @param {string} name */
export function panelNewCommand(name) {
  const dir = createPanel(name);
  console.log(`Created ${dir}`);
  console.log("It shows up as a Workbench tab in the desktop app, and reloads as you save.");
}
