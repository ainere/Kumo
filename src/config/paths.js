/**
 * paths.js — Single source of truth for Kumo's state directory and durable writes.
 *
 * The state directory defaults to `~/.kumo` but can be redirected with `KUMO_HOME`.
 * The env var is read on every call (never cached at module load) so tests and
 * wrappers can redirect state after the module graph is already imported.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Directory mode for Kumo state directories (owner-only). */
export const DIR_MODE = 0o700;
/** File mode for Kumo state files (owner-only). */
export const FILE_MODE = 0o600;

/**
 * Resolve the Kumo state directory.
 *
 * @returns {string}
 */
export function kumoHome() {
  const override = process.env.KUMO_HOME;
  if (typeof override === "string" && override.trim() !== "") {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".kumo");
}

/**
 * Path to the global config file inside the Kumo state directory.
 *
 * @returns {string}
 */
export function configFile() {
  return path.join(kumoHome(), "config.json");
}

/**
 * Create a directory (recursively) with owner-only permissions by default.
 *
 * @param {string} dir
 * @param {number|undefined} [mode=DIR_MODE] - pass undefined for the process umask default
 */
export function ensureDir(dir, mode = DIR_MODE) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, mode === undefined ? { recursive: true } : { recursive: true, mode });
  }
}

/**
 * Atomically write UTF-8 text (tmp file + rename; never leaves a truncated target).
 *
 * @param {string} file
 * @param {string} content
 * @param {number|undefined} [mode=FILE_MODE] - pass undefined for the process umask default
 */
export function atomicWriteText(file, content, mode = FILE_MODE) {
  ensureDir(path.dirname(file), mode === undefined ? undefined : DIR_MODE);
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, mode === undefined ? { encoding: "utf-8" } : { encoding: "utf-8", mode });
  fs.renameSync(tmp, file);
}

/**
 * Atomically write JSON (tmp file + rename).
 *
 * @param {string} file
 * @param {*} data
 * @param {number|undefined} [mode=FILE_MODE]
 */
export function atomicWriteJson(file, data, mode = FILE_MODE) {
  atomicWriteText(file, JSON.stringify(data, null, 2), mode);
}

/**
 * Move an unparseable state file aside instead of silently overwriting it.
 * Returns the quarantine path, or null when nothing was moved.
 *
 * @param {string} file
 * @returns {string|null}
 */
export function quarantineCorruptFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const dest = `${file}.corrupt.${Date.now()}`;
    fs.renameSync(file, dest);
    return dest;
  } catch {
    return null;
  }
}
