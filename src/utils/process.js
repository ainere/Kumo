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
 * Quote a single argument for `cmd /s /c`, so the program behind a `.cmd` shim
 * receives it byte-for-byte.
 *
 * Two parsers read the result. cmd.exe tracks quote parity (so inner quotes are
 * doubled, keeping `& | < > ^` inside a quoted run) and expands `%NAME%` even
 * inside quotes. `%%` is only an escape inside batch files — on a `cmd /c` line
 * it survives literally and `%%PATH%%` still expands — so every `%` is instead
 * stepped out of the quoted run as `^%`: the percent pass never sees a
 * `%NAME%` pair, and the caret pass then leaves a plain `%`. The target's
 * MSVCRT argv parser treats backslashes before a `"` as escapes, so those runs
 * are doubled.
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

  let out = '"';
  let backslashes = 0;
  for (const ch of str) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2) + '""';
    } else if (ch === "%") {
      out += "\\".repeat(backslashes * 2) + '"^%"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + '"';
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

/** Extensions Kumo can launch: executables directly, batch files via cmd.exe. */
const SPAWNABLE_EXTENSIONS = new Set([".exe", ".com", ".cmd", ".bat"]);

/**
 * Pick the spawnable candidate from `where.exe` output.
 *
 * npm installs every CLI as a trio — an extensionless POSIX shell script, a
 * `.cmd`, and a `.ps1` — and `where` lists the extensionless one first.
 * `CreateProcess` cannot run that file (ENOENT), so only names whose extension
 * is in PATHEXT are eligible. `where` already orders results by PATH, so the
 * first eligible line wins.
 *
 * @param {string[]} candidates - lines printed by `where.exe`
 * @param {string} [pathext] - the PATHEXT value to honor
 * @returns {string|null}
 */
export function pickWindowsCandidate(candidates, pathext = process.env.PATHEXT) {
  // PATHEXT also lists script types (.JS, .VBS, .WSF, …) that run through a
  // host program; CreateProcess and the cmd.exe path in prepareSpawn can only
  // start these four.
  const exts = String(pathext || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => SPAWNABLE_EXTENSIONS.has(e));
  for (const candidate of candidates) {
    if (exts.includes(path.extname(candidate).toLowerCase())) return candidate;
  }
  return null;
}

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
    const isWin = process.platform === "win32";
    const out = execFileSync(isWin ? "where.exe" : "which", [name], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    const lines = String(out)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const pick = isWin ? pickWindowsCandidate(lines) : lines[0];
    if (pick && fs.existsSync(pick)) {
      resolved = pick;
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
 *
 * Beyond the usual `*_API_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` names it
 * takes any `*_KEY` (SECRET_KEY, PRIVATE_KEY, STRIPE_KEY, …), database and
 * broker connection URLs (DATABASE_URL, REDIS_URL, MONGODB_URI, …), webhook
 * URLs, DSNs and connection strings, which embed credentials in the value.
 * Endpoint overrides such as OPENAI_BASE_URL are deliberately not matched.
 */
export const SECRET_ENV_RE = new RegExp(
  [
    "API_KEY|_TOKEN|_SECRET|PASSWORD|PASSWD|CREDENTIAL",
    "^(TOKEN|SECRET)",
    "_KEY$",
    "(^|_)(DATABASE|DB|REDIS|MONGO|POSTGRES|MYSQL|MARIADB|AMQP|RABBITMQ|SQL)[A-Z0-9_]*_?(URL|URI)$",
    "WEBHOOK|(^|_)DSN$|CONNECTION_?STRING",
  ].join("|"),
  "i"
);

/**
 * System variables a child needs to find binaries and its profile, compared
 * lower-case. They are never scrubbed, whatever {@link SECRET_ENV_RE} grows to
 * match: stripping one of them breaks binary resolution on Windows.
 */
const SAFE_ENV_NAMES = new Set([
  "path", "pathext", "home", "homedrive", "homepath", "userprofile", "appdata", "localappdata",
  "systemroot", "systemdrive", "windir", "comspec", "temp", "tmp", "tmpdir", "term", "lang",
  "shell", "user", "username", "logname", "programdata", "programfiles", "programfiles(x86)",
  "programw6432", "computername", "os",
]);

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
  // The subscription token `claude setup-token` prints, for a login made by
  // environment instead of on disk. Cloud-provider credentials are deliberately
  // not here: Kumo runs Claude Code on the subscription only.
  claude: ["CLAUDE_CODE_OAUTH_TOKEN"],
  // `gh copilot` authenticates from these when there is no stored login.
  copilot: ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"],
  // Cursor Agent's headless mode authenticates from its API key.
  cursor: ["CURSOR_API_KEY"],
  ollama: ["OLLAMA_API_KEY"],
};

/**
 * Variables (besides every `KUMO_*` one) the bridge needs from the session:
 * provider binary overrides, endpoint overrides, and the direct-API keys. The
 * single list both the Codex and the Claude orchestrator clients pass on.
 */
export const BRIDGE_ENV_NAMES = new Set([
  "AGY_BIN",
  "CODEX_BIN",
  "CLAUDE_BIN",
  "OLLAMA_BIN",
  "COPILOT_BIN",
  "CURSOR_BIN",
  "OPENCODE_BIN",
  "COMMANDCODE_BIN",
  "GEMINI_TIMEOUT_MS",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GEMINI_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "COMPAT_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "COMPAT_API_KEY",
]);

/**
 * Every name a lead passes on to its bridge: the fixed list, plus the own keys
 * of each worker provider the session actually assigns (`GH_TOKEN` for a
 * Copilot worker, `CURSOR_API_KEY` for a Cursor one, …). Those would otherwise
 * reach the lead and the bridge for nobody, so they follow the assignment; a
 * worker switched in mid-session finds its key only after the lead restarts.
 *
 * @param {string[]} [providers] - worker providers in use, canonical ids
 * @returns {Set<string>}
 */
export function bridgeEnvNames(providers = []) {
  const names = new Set(BRIDGE_ENV_NAMES);
  for (const provider of providers) {
    const id = String(provider || "").toLowerCase();
    if (Object.hasOwn(PROVIDER_ENV_KEEP, id)) for (const name of PROVIDER_ENV_KEEP[id]) names.add(name);
  }
  return names;
}

/**
 * The bridge's own variables that `env` holds. `childEnvFor` removes
 * credential-shaped names from an orchestrator's environment, and the keys
 * among them are what the orchestrator passes on to the bridge it starts, so a
 * lead's client hands them back through `extra`. Nothing else secret-looking
 * goes along.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string[]} [providers] - worker providers in use, see {@link bridgeEnvNames}
 * @returns {Record<string, string>}
 */
export function bridgeEnvFrom(env, providers = []) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of bridgeEnvNames(providers)) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  return out;
}

/**
 * Build the environment for a spawned provider CLI.
 *
 * Provider CLIs run with permission-bypass flags in write mode, so handing them
 * the operator's full credential environment would let any injected instruction
 * read and exfiltrate unrelated API keys. Non-secret variables (PATH, HOME,
 * APPDATA, ComSpec, TEMP, …) are preserved untouched — stripping those breaks
 * binary resolution on Windows.
 *
 * `ELECTRON_RUN_AS_NODE` is dropped too: the desktop app sets it for the bridge
 * only, and a child that inherited it would run Electron-based tools (and the
 * provider CLIs themselves) as plain Node. A caller that really wants it passes
 * it in `extra`.
 *
 * @param {string} provider - worker/orchestrator provider id
 * @param {Record<string, string|undefined>} [extra={}] - variables to set after scrubbing
 * @returns {Record<string, string>}
 */
export function childEnvFor(provider, extra = {}) {
  const env = { ...process.env };
  const id = String(provider || "").toLowerCase();
  const keep = new Set(Object.hasOwn(PROVIDER_ENV_KEEP, id) ? PROVIDER_ENV_KEEP[id] : []);

  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") {
      delete env[key];
    } else if (SECRET_ENV_RE.test(key) && !keep.has(key) && !SAFE_ENV_NAMES.has(key.toLowerCase())) {
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

/** Live output routed away from its file, keyed by the run's live-log path. */
const liveSinks = new Map();

/**
 * Send a run's live output to `sink` instead of its live-log file. The bridge
 * does this when an engine is connected: the output then streams over the
 * engine connection, tagged with its run, and no file is written. Returns a
 * function that removes the route.
 *
 * @param {string} liveLogPath
 * @param {(chunk: Buffer|string) => void} sink
 * @returns {() => void}
 */
export function routeLiveOutput(liveLogPath, sink) {
  liveSinks.set(liveLogPath, sink);
  return () => {
    if (liveSinks.get(liveLogPath) === sink) liveSinks.delete(liveLogPath);
  };
}

/**
 * Record a chunk of a worker's live output: to the route registered for its
 * live-log path, else appended to that file. Best-effort; never throws.
 *
 * @param {string|null|undefined} liveLogPath
 * @param {Buffer|string} chunk
 */
export function writeLiveOutput(liveLogPath, chunk) {
  if (!liveLogPath) return;
  const sink = liveSinks.get(liveLogPath);
  try {
    if (sink) sink(chunk);
    else fs.appendFileSync(liveLogPath, chunk);
  } catch {
    /* live output is best-effort telemetry */
  }
}

/**
 * Spawn a child and mirror its stdout/stderr as live output as it arrives
 * (see writeLiveOutput).
 *
 * The REPL renders that as worker progress. Attaching the tee here
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
    const append = (chunk) => writeLiveOutput(liveLogPath, chunk);
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
  }

  return proc;
}

// ── Termination ──

/**
 * Ask a long-lived child (an orchestrator CLI) to stop, together with
 * everything it spawned.
 *
 * On Windows `proc.kill()` terminates only the root — the `cmd.exe` shim, or
 * the CLI itself — and orphans its MCP bridge and any running worker, so the
 * whole tree is taken down. Elsewhere SIGTERM lets the CLI shut down cleanly;
 * its children see their stdin close and exit.
 *
 * @param {import("node:child_process").ChildProcess|null|undefined} proc
 * @param {NodeJS.Signals} [signal="SIGTERM"]
 */
export function stopProcessTree(proc, signal = "SIGTERM") {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === "win32") {
    killProcessTree(proc);
    return;
  }
  try {
    proc.kill(signal);
  } catch {
    /* already gone */
  }
}

/**
 * Terminate a child and everything it spawned.
 *
 * On Windows a signal reaches only the root process — usually the `cmd.exe`
 * shim — which orphans the real worker. `taskkill /T /F` walks the tree.
 *
 * @param {import("node:child_process").ChildProcess} proc
 */
export function killProcessTree(proc) {
  // Not `proc.killed`: that is set once a signal was *sent*, and on Windows a
  // signal only reaches the shim, so the tree may still be running.
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
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
