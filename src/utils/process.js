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
 *
 * Every worker and orchestrator adapter funnels through here, so binary
 * resolution, child-environment scrubbing, live-log teeing, and process-tree
 * termination are implemented once rather than in each of the ten adapters.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Determine if a target binary on Windows is a batch script (.cmd/.bat).
 *
 * @param {string} bin
 * @param {NodeJS.Platform} [platform=process.platform] - overridable so the
 *   Windows command-line logic is testable on every CI runner
 * @returns {boolean}
 */
export function isWindowsBatch(bin, platform = process.platform) {
  if (platform !== "win32") return false;
  if (!bin || typeof bin !== "string") return false;
  const ext = path.extname(bin).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

/**
 * Quote a single argument for `cmd /s /c`.
 * Safe chars pass through; otherwise double-quote, double inner quotes,
 * and neutralize `%VAR%` expansion. `& | < > ^` are inert inside quotes.
 *
 * `~` is in the safe set: it is inert to cmd.exe and appears in every 8.3
 * short path (`C:\Users\RUNNER~1\...`), so quoting it buys nothing.
 *
 * CR/LF cannot be quoted at all — `cmd.exe` treats a newline as a command
 * separator regardless of quoting, so such an argument is rejected outright.
 *
 * @param {*} s
 * @returns {string}
 */
export function quoteCmdArg(s) {
  const str = String(s);
  if (/[\r\n]/.test(str)) {
    throw new Error("Argument contains a newline and cannot be passed through cmd.exe safely");
  }
  if (/^[A-Za-z0-9_+=:;,.~\\/@-]+$/.test(str)) return str;
  return `"` + str.replace(/"/g, '""').replace(/%/g, "%%") + `"`;
}

/**
 * Prepares invocation arguments and options for child_process.spawn.
 *
 * On Windows the batch path hands cmd.exe a single, already-quoted command
 * line. Node would otherwise apply MSVCRT argument escaping to it and turn our
 * `"` into `\"`, which cmd.exe does not understand — the symptom is
 * `'\"C:\path\tool.cmd\"' is not recognized as an internal or external
 * command`, hit by any binary path containing a space, `(`, or other character
 * that forces quoting. `windowsVerbatimArguments` passes the line through
 * untouched, and the outer quote pair is the wrapper `/s` strips before
 * parsing. This mirrors what Node itself does for `shell: true`.
 *
 * @param {string} bin - Path or command name to execute
 * @param {string[]} [args=[]] - Command arguments
 * @param {import("node:child_process").SpawnOptions} [options={}] - Spawn options
 * @param {NodeJS.Platform} [platform=process.platform]
 * @returns {{ file: string, args: string[], options: import("node:child_process").SpawnOptions }}
 */
export function prepareSpawn(bin, args = [], options = {}, platform = process.platform) {
  const { shell: _ignoredShell, ...cleanOptions } = options;

  if (isWindowsBatch(bin, platform)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    const commandLine = [bin, ...args].map(quoteCmdArg).join(" ");
    return {
      file: comspec,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      options: {
        ...cleanOptions,
        shell: false,
        windowsVerbatimArguments: true,
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

// ── Binary resolution ──

const binaryCache = new Map();

/**
 * Resolve a bare command name to an absolute path via `where`/`which`.
 *
 * npm installs CLI workers as `.cmd` shims on Windows; spawning the bare name
 * with `shell: false` fails with ENOENT, and `isWindowsBatch` cannot detect a
 * shim it never sees the extension of. Falls back to the bare name so callers
 * keep their existing behavior when the probe finds nothing.
 *
 * @param {string} name
 * @returns {string}
 */
export function resolveBinary(name) {
  if (!name || typeof name !== "string") return name;
  if (path.isAbsolute(name)) return name;
  if (binaryCache.has(name)) return binaryCache.get(name);

  let resolved = name;
  try {
    const probe = process.platform === "win32" ? "where.exe" : "which";
    const out = execFileSync(probe, [name], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 5000,
    });
    const first = String(out)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (first && fs.existsSync(first)) {
      resolved = first;
    }
  } catch {
    /* not on PATH; keep the bare name */
  }

  binaryCache.set(name, resolved);
  return resolved;
}

/** Test seam: drop memoized binary lookups. */
export function clearBinaryCache() {
  binaryCache.clear();
}

// ── Child environment ──

/**
 * Environment variables that look like credentials. Anything matching is
 * removed from a child's environment unless the provider explicitly needs it.
 */
export const SECRET_ENV_RE = /(API_KEY|_TOKEN|_SECRET|PASSWORD|CREDENTIAL)/i;

/**
 * Per-provider credential allowlist. CLI workers authenticate from their own
 * on-disk session, so they need nothing; the table exists so a future provider
 * that does need a key has exactly one place to declare it.
 */
const PROVIDER_ENV_KEEP = {
  "openai-api": ["OPENAI_API_KEY", "COMPAT_API_KEY"],
  "compat-api": ["OPENAI_API_KEY", "COMPAT_API_KEY"],
  "anthropic-api": ["ANTHROPIC_API_KEY"],
  "gemini-api": ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
};

/**
 * Build the environment for a spawned provider CLI.
 *
 * Provider CLIs run with permission-bypass flags in write mode, so handing them
 * the operator's full credential environment would let any injected instruction
 * read and exfiltrate unrelated API keys. Non-secret variables (PATH, HOME,
 * APPDATA, ComSpec, TEMP, …) are preserved untouched — stripping those breaks
 * binary resolution on Windows.
 *
 * @param {string} provider - worker/orchestrator provider id
 * @param {Record<string, string|undefined>} [extra={}] - variables to set after scrubbing
 * @returns {Record<string, string>}
 */
export function childEnvFor(provider, extra = {}) {
  const env = { ...process.env };
  const keep = new Set(PROVIDER_ENV_KEEP[String(provider || "").toLowerCase()] || []);

  for (const key of Object.keys(env)) {
    if (SECRET_ENV_RE.test(key) && !keep.has(key)) {
      delete env[key];
    }
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }

  return env;
}

// ── Live log teeing ──

/**
 * Spawn a child and mirror its stdout/stderr into `liveLogPath` as it arrives.
 *
 * The REPL tails that file to render worker progress. Attaching the tee here
 * means every adapter gets it; additional `data` listeners on the same streams
 * continue to work, since Node delivers each chunk to every listener.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} options
 * @param {string|null} [liveLogPath]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnWithLiveLog(bin, args, options, liveLogPath = null) {
  const proc = safeSpawn(bin, args, options);

  if (liveLogPath) {
    const append = (chunk) => {
      try {
        fs.appendFileSync(liveLogPath, chunk);
      } catch {
        /* live log is best-effort telemetry */
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
  }

  return proc;
}

// ── Termination ──

/**
 * Terminate a child and everything it spawned.
 *
 * On Windows a signal reaches only the root process — usually the `cmd.exe`
 * shim — which orphans the real worker. `taskkill /T /F` walks the tree.
 *
 * @param {import("node:child_process").ChildProcess} proc
 */
export function killProcessTree(proc) {
  if (!proc || proc.killed || proc.exitCode !== null) return;
  if (process.platform === "win32" && proc.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
      });
      return;
    } catch {
      /* fall through to the signal path */
    }
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}
