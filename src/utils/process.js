/**
 * process.js — Process spawning utilities with cross-platform safety.
 *
 * Prevents Node.js deprecation warning [DEP0190] on Windows:
 * "Passing args to a child process with shell option true can lead to security vulnerabilities,
 *  as the arguments are not escaped, only concatenated."
 *
 * On Windows, executing a .cmd or .bat file directly with `shell: false` fails with EINVAL.
 * Instead of setting `shell: true` with an args array (which triggers DEP0190 and security risks),
 * this module routes Windows batch scripts through `%ComSpec% /d /s /c` with `shell: false`.
 */

import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Determine if a target binary on Windows is a batch script (.cmd/.bat) or extensionless.
 *
 * @param {string} bin
 * @returns {boolean}
 */
export function isWindowsBatch(bin) {
  if (process.platform !== "win32") return false;
  if (!bin || typeof bin !== "string") return false;
  const ext = path.extname(bin).toLowerCase();
  return ext === ".cmd" || ext === ".bat" || !ext;
}

/**
 * Prepares invocation arguments and options for child_process.spawn.
 *
 * @param {string} bin - Path or command name to execute
 * @param {string[]} [args=[]] - Command arguments
 * @param {import("node:child_process").SpawnOptions} [options={}] - Spawn options
 * @returns {{ file: string, args: string[], options: import("node:child_process").SpawnOptions }}
 */
export function prepareSpawn(bin, args = [], options = {}) {
  const { shell: _ignoredShell, ...cleanOptions } = options;

  if (isWindowsBatch(bin)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return {
      file: comspec,
      args: ["/d", "/s", "/c", bin, ...args],
      options: {
        ...cleanOptions,
        shell: false,
      },
    };
  }

  return {
    file: bin,
    args,
    options: {
      ...cleanOptions,
      shell: false,
    },
  };
}

/**
 * Safe wrapper around child_process.spawn that avoids [DEP0190] on Windows.
 *
 * @param {string} bin
 * @param {string[]} [args=[]]
 * @param {import("node:child_process").SpawnOptions} [options={}]
 * @returns {import("node:child_process").ChildProcess}
 */
export function safeSpawn(bin, args = [], options = {}) {
  const prep = prepareSpawn(bin, args, options);
  return spawn(prep.file, prep.args, prep.options);
}
