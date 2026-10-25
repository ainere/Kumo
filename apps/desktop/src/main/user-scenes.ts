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
 * The user's scenes folder, `<KUMO_HOME>/scenes`: which scene files are in it,
 * TypeScript scenes turned into classic scripts, and a watcher that tells the
 * window when the set changes. Only Node modules here, so it can run (and be
 * tested) outside Electron; scene-protocol.ts serves what this finds.
 */

import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

/** One scene script in the folder. Mirrors `SceneFile` in the renderer's types.ts. */
export interface SceneFile {
  /** File name, e.g. "sharks.ts". */
  file: string;
  /** The path the scene page serves it at, e.g. "/user/sharks.ts". */
  src: string;
  kind: "js" | "ts";
  /** Why it can't run (a TypeScript error, too large), else null. */
  error: string | null;
  mtime: number;
}

export interface SceneList {
  dir: string;
  files: SceneFile[];
}

const SCENE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|ts)$/;
const MAX_SCENE_BYTES = 4 * 1024 * 1024;
const WATCH_DEBOUNCE_MS = 150;
const REARM_MS = 2000;

/** A name that may be read from the scenes folder. Declaration files are types, not scenes. */
export function isSceneFileName(name: string): boolean {
  return SCENE_FILE.test(name) && !name.endsWith(".d.ts");
}

/** The same directory as src/config/paths.js kumoHome(). */
export function userScenesDir(): string {
  const override = process.env.KUMO_HOME;
  const home = override && override.trim() !== "" ? path.resolve(override) : path.join(os.homedir(), ".kumo");
  return path.join(home, "scenes");
}

export function ensureUserScenesDir(): string {
  const dir = userScenesDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** One line a person can read: the message, with the line number of a syntax error. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 300);
  // A syntax error's stack opens with its position (":2", "name.ts:2").
  const line = err.name === "SyntaxError" ? /:(\d+)$/.exec((err.stack ?? "").split("\n", 1)[0])?.[1] : undefined;
  const text = err.message.split("\n", 1)[0].slice(0, 300);
  return line ? `Line ${line}: ${text}` : text;
}

type Compiled = { code: string; error: null } | { code: null; error: string };

/** Compiled .ts scenes by file name, valid while the file's mtime and size match. */
const compiled = new Map<string, { mtimeMs: number; size: number; result: Compiled }>();

/**
 * Type stripping only: no enums, namespaces or parameter properties, and no
 * imports but `import type`. A scene is one classic script.
 */
function compileTs(name: string, file: string, stat: fs.Stats): Compiled {
  const hit = compiled.get(name);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.result;
  let source: string;
  try {
    source = fs.readFileSync(file, "utf-8");
  } catch (err) {
    // Not cached: an editor holding the file mid-save may not change its mtime.
    return { code: null, error: describeError(err) };
  }
  let result: Compiled;
  try {
    // Strip mode blanks types out in place, so line numbers in errors the
    // scene throws still match the source.
    const code = stripTypeScriptTypes(source, { mode: "strip" });
    // The page runs scenes as classic scripts, which an `import { type X }`
    // the stripper leaves behind would only break inside the iframe. Parsing
    // (never running) it here reports that against the file instead.
    void new vm.Script(code, { filename: name });
    result = { code, error: null };
  } catch (err) {
    result = { code: null, error: describeError(err) };
  }
  compiled.set(name, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}

/** `code` is set for .ts scenes only; a .js scene is read when it's served. */
function inspect(name: string): { info: SceneFile; code: string | null } | undefined {
  if (!isSceneFileName(name)) return undefined;
  const file = path.join(userScenesDir(), name);
  const info: SceneFile = {
    file: name,
    src: `/user/${name}`,
    kind: name.endsWith(".ts") ? "ts" : "js",
    error: null,
    mtime: 0,
  };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    return isMissing(err) ? undefined : { info: { ...info, error: describeError(err) }, code: null };
  }
  if (!stat.isFile()) return undefined;
  info.mtime = Math.floor(stat.mtimeMs);
  if (stat.size > MAX_SCENE_BYTES) return { info: { ...info, error: "Larger than 4 MB" }, code: null };
  if (info.kind === "js") return { info, code: null };
  const result = compileTs(name, file, stat);
  return { info: { ...info, error: result.error }, code: result.code };
}

/** Every scene file in the folder, broken ones included; empty when there is no folder. */
export function scanUserScenes(): SceneFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(userScenesDir());
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const files = names
    .filter(isSceneFileName)
    .sort()
    .flatMap((name) => inspect(name)?.info ?? []);
  const present = new Set(files.map((f) => f.file));
  for (const name of compiled.keys()) if (!present.has(name)) compiled.delete(name);
  return files;
}

/** The folder (created if missing) and what's in it. */
export function listUserScenes(): SceneList {
  const dir = ensureUserScenesDir();
  return { dir, files: scanUserScenes() };
}

/** The script to serve for a scene file, or undefined if it's missing, broken or not a valid name. */
export function readUserScene(name: string): string | undefined {
  const scene = inspect(name);
  if (!scene || scene.info.error) return undefined;
  if (scene.code !== null) return scene.code;
  try {
    return fs.readFileSync(path.join(userScenesDir(), name), "utf-8");
  } catch (err) {
    if (!isMissing(err)) console.error(`kumo: can't read the scene ${name}:`, err);
    return undefined;
  }
}

/**
 * Calls onChange (debounced) when a scene file is added, changed or removed,
 * and keeps working when the folder is created later or deleted. Returns a
 * function that stops watching.
 */
export function watchUserScenes(onChange: () => void): () => void {
  const dir = userScenesDir();
  let watcher: fs.FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastFailure = "";

  const fire = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (!stopped) onChange();
    }, WATCH_DEBOUNCE_MS);
  };

  const drop = (): void => {
    watcher?.close();
    watcher = null;
  };

  const arm = (): boolean => {
    try {
      const w = fs.watch(dir, { persistent: false }, (_event, name) => {
        // Editors write temp files beside the scene; only scene names count.
        if (name === null || isSceneFileName(String(name))) fire();
      });
      // Windows reports the watched folder's deletion as an error event.
      w.on("error", () => {
        if (watcher === w) {
          drop();
          fire();
        }
      });
      watcher = w;
      lastFailure = "";
      return true;
    } catch (err) {
      const failure = String(err);
      if (!isMissing(err) && failure !== lastFailure) console.error("kumo: can't watch the scenes folder:", err);
      lastFailure = failure;
      return false;
    }
  };

  arm();
  // The folder may not exist yet, or may go away; inotify and kqueue say
  // nothing then. Checking every couple of seconds re-arms the watcher.
  const supervisor = setInterval(() => {
    if (watcher && !fs.existsSync(dir)) {
      drop();
      fire();
    }
    // Back after being gone: its files may have changed while nobody watched.
    if (!watcher && arm()) fire();
  }, REARM_MS);

  return () => {
    stopped = true;
    clearInterval(supervisor);
    if (debounce) clearTimeout(debounce);
    drop();
  };
}
