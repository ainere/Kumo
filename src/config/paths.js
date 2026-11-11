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
  try {
    // Inside the try: a write cut short (a full disk) leaves half a temp file to clear away too.
    fs.writeFileSync(tmp, content, mode === undefined ? { encoding: "utf-8" } : { encoding: "utf-8", mode });
    renameWithRetry(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the write or rename error below is the one worth reporting */
    }
    throw err;
  }
}

/** Error codes of a sharing violation: another program briefly holds the target. */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Waits between rename attempts, in ms. On Windows, antivirus, the search indexer and OneDrive hold files for a few ms; worst case 5 attempts, 310 ms of waiting. */
const RENAME_RETRY_DELAYS_MS = [10, 40, 80, 180];

/** Block this thread for `ms` without spinning the CPU. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename, retrying a few times when the target is held by another program.
 * Any other error, or the last transient one, is thrown.
 *
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err)?.code;
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !code || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
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
