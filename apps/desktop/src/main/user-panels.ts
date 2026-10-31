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
 * The user's custom panels, `<KUMO_HOME>/panels/<id>/`: a `panel.html` that
 * becomes a Workbench tab, an optional `panel.json` naming it, and whatever
 * files the page loads. Only Node modules here, so it can run (and be tested)
 * outside Electron; panel-protocol.ts serves what this reads.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PANEL_SCHEME = "kumo-panel";

/** One panel. Mirrors `UserPanel` in the renderer's types.ts. */
export interface UserPanel {
  id: string;
  name: string;
  /** Where the page is served: the id is the URL's host. */
  src: string;
  /** Why part of it was left out (bad JSON), else null. */
  error: string | null;
}

export interface PanelList {
  dir: string;
  panels: UserPanel[];
}

/** A file a panel's page may load. */
export interface PanelAsset {
  body: Buffer;
  type: string;
}

// Lower case only: the id is a URL host, and hosts are. Windows doesn't mind the folder's own case.
const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PANEL_PAGE = "panel.html";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 150;

const ASSET_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

/** The same directory as src/config/paths.js kumoHome(). */
export function userPanelsDir(): string {
  const override = process.env.KUMO_HOME;
  const home = override && override.trim() !== "" ? path.resolve(override) : path.join(os.homedir(), ".kumo");
  return path.join(home, "panels");
}

export function ensureUserPanelsDir(): string {
  const dir = userPanelsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readPanel(id: string, dir: string): UserPanel | null {
  if (!fs.statSync(path.join(dir, PANEL_PAGE), { throwIfNoEntry: false })?.isFile()) return null;
  const panel: UserPanel = { id, name: id, src: `${PANEL_SCHEME}://${id}/`, error: null };
  try {
    const manifest = path.join(dir, "panel.json");
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf-8")) as Record<string, unknown>;
      if (typeof parsed.name === "string" && parsed.name.trim()) panel.name = parsed.name.trim().slice(0, 24);
    }
  } catch (err) {
    panel.error = `panel.json: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
  }
  return panel;
}

/** Every panel in the folder, by name. */
export function listUserPanels(): PanelList {
  const dir = ensureUserPanelsDir();
  const panels: UserPanel[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const id = entry.name.toLowerCase();
    if (!entry.isDirectory() || !PANEL_ID.test(id)) continue;
    const panel = readPanel(id, path.join(dir, entry.name));
    if (panel) panels.push(panel);
  }
  panels.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, panels };
}

/**
 * A file of panel `id`, or null when it isn't one a page may load: the path has
 * to stay inside the panel's own folder, links included.
 */
export function readPanelAsset(id: string, pathname: string): PanelAsset | null {
  if (!PANEL_ID.test(id)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, "") || PANEL_PAGE;
  } catch {
    return null;
  }
  if (rel.includes("\0") || rel.includes(":") || rel.split(/[\\/]/).includes("..")) return null;
  const type = ASSET_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return null;
  try {
    const root = fs.realpathSync.native(path.join(userPanelsDir(), id));
    const file = fs.realpathSync.native(path.join(root, rel));
    if (!file.startsWith(`${root}${path.sep}`)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return null;
    return { body: fs.readFileSync(file), type };
  } catch {
    return null;
  }
}

/** Calls onChange (debounced) when anything in the panels folder changes. Returns a function that stops watching. */
export function watchUserPanels(onChange: () => void): () => void {
  let debounce: NodeJS.Timeout | null = null;
  const watcher = fs.watch(ensureUserPanelsDir(), { persistent: false, recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, WATCH_DEBOUNCE_MS);
  });
  watcher.on("error", (err) => console.error("kumo: can't watch the panels folder:", err));
  return () => {
    if (debounce) clearTimeout(debounce);
    watcher.close();
  };
}
