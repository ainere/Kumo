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
 * accounts.js — Which providers can be used now, and how to sign in or out.
 *
 * Settings › Accounts and the first-run wizard read this. Kumo never handles
 * credentials: a subscription CLI says whether it is signed in (its own
 * status command), and signing in or out is that CLI's own login or logout
 * command, run in a terminal Kumo opens (sign-in) or without a terminal
 * (sign-out). API providers are "signed in" when their key is in the
 * environment; the value is never read into a result.
 *
 * The commands live in one fixed table (CLI_PROVIDERS). A provider id from
 * outside is checked against it, and no text from outside reaches a command
 * line. Only commands verified with `--help` on a real install are listed
 * (2026-10-25: Claude Code 2.1.310, Codex 0.153.4, agy 1.4.7, gh 2.91.0,
 * Ollama 0.32.15); a CLI that offers no way to read or change its login
 * gets `null` and an honest detail instead.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWED_PROVIDERS, canonicalizeProvider, providerDisplayName } from "../config/models.js";
import { loadConfig, isSafeBaseUrl } from "../config/settings.js";
import { safeSpawn, resolveBinary, killProcessTree, childEnvFor } from "../utils/process.js";
import { getCliBinary, checkAgyHealth } from "../bridge/agy-runner.js";
import { findCodexBinary } from "../providers/orchestrators/codex.js";
import { findClaudeBinary } from "../providers/workers/claude.js";
import { findCopilotBinary } from "../providers/workers/copilot.js";
import { findCursorBinary } from "../providers/workers/cursor.js";
import { findOllamaBinary } from "../providers/workers/ollama.js";
import { findOpencodeBinary } from "../providers/workers/opencode.js";
import { findCommandcodeBinary } from "../providers/workers/commandcode.js";
import { getCachedQuotas, saveProviderQuotas, dropProviderQuotas } from "../utils/quota-cache.js";
import { formatPlanType, formatResetTime } from "../utils/ui.js";
import { readBoundedText } from "../providers/api/api-transport.js";
import { launchTerminalCommand } from "../utils/window-launcher.js";

/** @typedef {"subscription" | "api" | "local"} AccountKind */

/**
 * One provider as Settings shows it. Mirrors `AccountStatus` in the desktop
 * renderer's types.ts; every field is always present.
 *
 * @typedef {Object} AccountStatus
 * @property {string} provider
 * @property {string} name
 * @property {AccountKind} kind
 * @property {boolean} installed
 * @property {string | null} version
 * @property {boolean | null} signedIn
 * @property {string | null} account
 * @property {string | null} plan
 * @property {string} detail
 * @property {boolean} canSignIn
 * @property {boolean} canSignOut
 * @property {string | null} envVar
 * @property {string | null} baseUrl
 */

/**
 * @typedef {Object} SignInResult
 * @property {boolean} launched
 * @property {string} command
 */

/**
 * @typedef {Object} EndpointTest
 * @property {boolean} ok
 * @property {string} detail
 * @property {string[]} models
 */

/**
 * The end of a probe: what the process did, or that it never started.
 *
 * @typedef {Object} ProbeRun
 * @property {boolean} started - false when the executable could not be launched at all
 * @property {number | null} code - null when it was killed or never started
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 */

/** How long one status or version command may run before its process tree is killed. */
const PROBE_TIMEOUT_MS = 8000;
/** A logout may talk to the provider's servers. */
const SIGN_OUT_TIMEOUT_MS = 15_000;
/** However the probes of one provider behave, its entry is answered by then. */
const PROVIDER_DEADLINE_MS = 12_000;
/** Account status changes rarely and a probe spawns processes. */
const CACHE_TTL_MS = 30_000;
/** Endpoint tests are user-driven and interactive. */
const ENDPOINT_TIMEOUT_MS = 5000;
/** The local-server check that runs for every list. */
const LOCAL_SERVER_TIMEOUT_MS = 3000;
/** Probe output is read for a line or a JSON document; nothing needs more. */
const MAX_PROBE_OUTPUT = 64 * 1024;
const MAX_ENDPOINT_MODELS = 500;

/**
 * Run a provider CLI to completion with a deadline. On timeout the whole
 * process tree is killed (on Windows the `.cmd` shim is not the real
 * process). The environment is the provider's own scrubbed one, so other
 * providers' keys never reach the child.
 *
 * @param {string} provider
 * @param {string} bin
 * @param {string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<ProbeRun>}
 */
export function runProbe(provider, bin, args, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = safeSpawn(resolveBinary(bin), args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnvFor(provider),
        windowsHide: true,
      });
    } catch {
      resolve({ started: false, code: null, timedOut: false, stdout: "", stderr: "" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    /** @param {Partial<ProbeRun>} end */
    const finish = (end) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ started: true, code: null, timedOut: false, stdout, stderr, ...end });
    };
    const timer = setTimeout(() => {
      killProcessTree(proc);
      // Not waiting for `close`: a grandchild can hold the pipes open.
      finish({ timedOut: true });
    }, timeoutMs);

    proc.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_PROBE_OUTPUT) stderr += chunk.toString();
    });
    proc.on("error", () => finish({ started: false }));
    proc.on("close", (code) => finish({ code }));
  });
}

/**
 * What the module calls out to, replaceable in tests so they never start a
 * real CLI, open a terminal or log anyone out.
 */
const defaultDeps = {
  run: runProbe,
  launch: launchTerminalCommand,
  agyHealth: () => checkAgyHealth(),
  deadlineMs: PROVIDER_DEADLINE_MS,
};
let deps = defaultDeps;

/**
 * Test seam: replace some of the module's dependencies (and drop every cached
 * result). Call with no argument to restore them.
 *
 * @param {Partial<typeof defaultDeps>} [overrides]
 */
export function setAccountsDeps(overrides = {}) {
  deps = { ...defaultDeps, ...overrides };
  clearAccountCache();
}

/** @param {unknown} err */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether an environment variable holds something. Only presence is ever
 * asked of a key; the value never goes into a result.
 *
 * @param {string} name
 */
function hasEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/** @param {string} bin */
function binaryExists(bin) {
  return path.isAbsolute(bin) && fs.existsSync(bin);
}

/**
 * Whether the executable exists, judged by its `--version` run: it printed a
 * version, or it started and then did not answer in time. A slow answer is
 * not an absent program; only a run that never started, or ended with an
 * error, means the command is not there.
 *
 * @param {string} bin
 * @param {ProbeRun} versionRun
 */
function isInstalled(bin, versionRun) {
  return binaryExists(bin) || versionRun.code === 0 || (versionRun.started && versionRun.timedOut);
}

/**
 * The version printed by `--version`, from whichever stream carries it (Ollama
 * prints it to stderr when no server is running).
 *
 * @param {ProbeRun} run
 * @returns {string | null}
 */
function parseVersion(run) {
  if (run.code !== 0) return null;
  for (const text of [run.stdout, run.stderr]) {
    const match = /\b(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/.exec(text);
    if (match) return match[1];
  }
  return null;
}

/**
 * A URL for people: no credentials, query or fragment, no trailing slash.
 *
 * @param {string} raw
 * @returns {string | null} null when it is not a URL
 */
function displayUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * @param {string} provider
 * @param {AccountKind} kind
 * @returns {AccountStatus}
 */
function blankStatus(provider, kind) {
  return {
    provider,
    name: providerDisplayName(provider),
    kind,
    installed: false,
    version: null,
    signedIn: null,
    account: null,
    plan: null,
    detail: "",
    canSignIn: false,
    canSignOut: false,
    envVar: null,
    baseUrl: null,
  };
}

// ── Subscription CLIs ──

/**
 * What a CLI's own status command says.
 *
 * @typedef {Object} CliReading
 * @property {boolean | null} signedIn
 * @property {string | null} [account]
 * @property {string | null} [plan]
 * @property {string} detail
 */

/**
 * @typedef {Object} CliContext
 * @property {string} bin - the executable, as Kumo itself runs it
 * @property {(args: string[]) => Promise<ProbeRun>} run
 */

/**
 * @typedef {Object} CliProvider
 * @property {string} command - the bare executable name, for people and as the fallback on a command line
 * @property {() => string} binary - the executable Kumo itself uses (override variable, else resolved)
 * @property {string[] | null} signIn - arguments of the provider's own login command; null when there is none Kumo can run
 * @property {string[] | null} signOut - arguments of its non-interactive logout command; null when there is none
 * @property {string} [noSignOut] - why Kumo offers no sign-out
 * @property {string} [noSignIn] - why Kumo offers no sign-in
 * @property {(bin: string) => string | null} [noSignInFor] - why the login command cannot be run through this executable, or null
 * @property {(ctx: CliContext) => Promise<CliReading>} read - the sign-in state, for an installed CLI
 */

/** @param {string} name */
function unreadable(name) {
  return { signedIn: null, detail: `${name} is installed, but it has no command Kumo can use to read its sign-in.` };
}

/** @param {string} text @param {number} max */
function plainText(text, max) {
  return text.replace(/[^A-Za-z0-9 ._-]/g, "").trim().slice(0, max);
}

/** Claude's `subscriptionType` values, as plans are named. */
const CLAUDE_PLANS = /** @type {Record<string, string>} */ ({
  free: "Claude Free",
  pro: "Claude Pro",
  max: "Claude Max",
  team: "Claude Team",
  enterprise: "Claude Enterprise",
});

/** @param {unknown} type */
function claudePlan(type) {
  if (typeof type !== "string" || !type.trim()) return null;
  const key = type.trim().toLowerCase();
  if (Object.hasOwn(CLAUDE_PLANS, key)) return CLAUDE_PLANS[key];
  const words = plainText(key.replace(/_/g, " "), 30);
  return words ? `Claude ${words.replace(/\b[a-z]/g, (c) => c.toUpperCase())}` : null;
}

/** @type {(ctx: CliContext) => Promise<CliReading>} */
async function readClaude({ run }) {
  const res = await run(["auth", "status"]);
  if (res.timedOut) return { signedIn: null, detail: "Timed out reading the sign-in status." };
  /** @type {any} */
  let info = null;
  try {
    info = JSON.parse(res.stdout);
  } catch {
    /* handled below */
  }
  if (!info || typeof info.loggedIn !== "boolean") {
    return { signedIn: null, detail: "Could not read the sign-in status from `claude auth status`." };
  }
  if (!info.loggedIn) return { signedIn: false, detail: "Not signed in." };
  const method = typeof info.authMethod === "string" ? info.authMethod : "";
  return {
    signedIn: true,
    account: typeof info.email === "string" && info.email ? info.email : null,
    plan: claudePlan(info.subscriptionType),
    detail: method === "claude.ai" ? "Logged in with your Claude subscription." : `Logged in (${plainText(method, 30) || "unknown method"}).`,
  };
}

/** `claude -p /usage` answers from the account in about a second; past this something is wrong. */
const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

/**
 * `/usage` as a local command (no model call), without saving a session for
 * each read or loading the user's hooks, MCP servers and CLAUDE.md
 * (`--safe-mode`; `--bare` would also skip the sign-in).
 */
const CLAUDE_USAGE_ARGS = ["-p", "/usage", "--no-session-persistence", "--safe-mode"];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Epoch milliseconds of a wall-clock time in an IANA time zone (the local
 * zone when Intl doesn't know it).
 *
 * @param {number} year
 * @param {number} month 0-11
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {string | null} timeZone
 */
function zonedTime(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  if (!timeZone) return new Date(year, month, day, hour, minute).getTime();
  let format;
  try {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  } catch {
    return new Date(year, month, day, hour, minute).getTime();
  }
  /** @param {number} t how far the zone's clock is ahead of UTC at t */
  const offset = (t) => {
    const p = Object.fromEntries(format.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - t;
  };
  const first = wall - offset(wall);
  // Once more, for a time near a daylight-saving change.
  return wall - offset(first);
}

/**
 * When a `/usage` window resets, from "Oct 26, 3:49am (Asia/Manila)" or
 * "3:49am (Asia/Manila)" (later today). Null when it can't be read.
 *
 * @param {string} text
 * @param {number} now epoch ms
 * @returns {number | null} epoch seconds
 */
function claudeResetAt(text, now) {
  const m = /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?\s*$/i.exec(text.trim());
  if (!m) return null;
  const [, mon, day, h, min, ampm, zone] = m;
  let hour = Number(h) % 24;
  if (ampm) hour = (Number(h) % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  const minute = Number(min ?? 0);
  const timeZone = zone?.trim() || null;
  const today = new Date(now);
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month === -1) return null;
    // No year is given: this year, or the next when that date has passed (December's reset read in January's terms).
    let at = zonedTime(today.getFullYear(), month, Number(day), hour, minute, timeZone);
    if (at < now - 24 * 3600 * 1000) at = zonedTime(today.getFullYear() + 1, month, Number(day), hour, minute, timeZone);
    return Math.round(at / 1000);
  }
  let at = zonedTime(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute, timeZone);
  if (at < now) at += 24 * 3600 * 1000;
  return Math.round(at / 1000);
}

/**
 * Claude Code's `/usage` text as limits in the shape Codex reports (and the
 * Claude client's `rate_limit_event` reading): the session (5-hour) window
 * as the primary limit, the all-models week as `secondary`. Null when it
 * shows no plan usage (an API key, or a format this doesn't know).
 *
 * @param {string} text
 * @param {number} [now] epoch ms
 * @returns {Record<string, unknown> | null}
 */
export function parseClaudeUsage(text, now = Date.now()) {
  /** @type {Record<string, any> | null} */
  let session = null;
  /** @type {Record<string, any> | null} */
  let week = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*Current (session|week)(?:\s*\(([^)]*)\))?\s*:\s*(\d+(?:\.\d+)?)%\s*used(?:.*?\bresets\s+(.+))?$/i.exec(line);
    if (!m) continue;
    const [, kind, scope, used, reset] = m;
    // The week across all models is the limit; per-model weeks (Sonnet only) are a share of it.
    if (kind.toLowerCase() === "week" && scope && !/all/i.test(scope) && week) continue;
    const usedPercent = Math.round(Math.min(100, Math.max(0, Number(used))));
    const resetsAt = reset ? claudeResetAt(reset, now) : null;
    const windowMinutes = kind.toLowerCase() === "session" ? 300 : 10080;
    const limits = {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt,
      resetFormatted: resetsAt ? formatResetTime(resetsAt) : null,
      windowMinutes,
    };
    if (kind.toLowerCase() === "session") session = limits;
    else if (!week || (scope && /all/i.test(scope))) week = limits;
  }
  const primary = session || week;
  if (!primary) return null;
  return { ...primary, secondary: session && week ? week : null, planType: "Claude subscription", creditsAvailable: 0 };
}

/**
 * The Claude subscription's usage, read through Claude Code's own `/usage`
 * (Kumo never holds the account's credentials). Null when Claude Code isn't
 * there, isn't signed in to a plan, or doesn't answer in time.
 *
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getClaudeUsage() {
  const res = await deps.run("claude", findClaudeBinary(), CLAUDE_USAGE_ARGS, CLAUDE_USAGE_TIMEOUT_MS);
  if (!res.started || res.timedOut || res.code !== 0) return null;
  return parseClaudeUsage(res.stdout);
}

/**
 * The Codex plan as the last quota read named it, else just "ChatGPT".
 *
 * @returns {string}
 */
function codexPlan() {
  const cached = getCachedQuotas().codex;
  const raw = String(cached?.rawPlan ?? cached?.planType ?? "").trim();
  if (!raw) return "ChatGPT";
  const label = formatPlanType(raw);
  if (/^chatgpt\b/i.test(label)) return label;
  const word = plainText(raw, 30);
  return word ? `ChatGPT ${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}` : "ChatGPT";
}

/** @type {(ctx: CliContext) => Promise<CliReading>} */
async function readCodex({ run }) {
  const res = await run(["login", "status"]);
  if (res.timedOut) return { signedIn: null, detail: "Timed out reading the sign-in status." };
  if (res.code !== 0) return { signedIn: false, detail: "Not signed in." };
  // The status line can carry a masked key; it is matched, never repeated.
  const text = `${res.stdout}\n${res.stderr}`;
  if (/chatgpt/i.test(text)) return { signedIn: true, plan: codexPlan(), detail: "Logged in using ChatGPT." };
  if (/api key/i.test(text)) return { signedIn: true, detail: "Logged in using an API key." };
  return { signedIn: true, detail: "Logged in." };
}

/** @type {(ctx: CliContext) => Promise<CliReading>} */
async function readAntigravity() {
  // `agy` has no status command: the usage query only answers for a signed-in account.
  const health = await deps.agyHealth();
  if (!health.authenticated) {
    return { signedIn: false, detail: "Not signed in, or agy returned no usage. Run agy and sign in." };
  }
  if (health.usage) {
    saveProviderQuotas("antigravity", null, health.usage);
  }
  return { signedIn: true, plan: "Google AI Pro", detail: "Signed in. agy has no sign-out command; sign out from inside agy." };
}

/**
 * Copilot runs through GitHub CLI. A custom COPILOT_BIN is a command Kumo
 * knows nothing about: it neither reads its sign-in nor launches its login.
 *
 * @param {string} bin
 */
function isGitHubCli(bin) {
  return path.basename(bin).toLowerCase().replace(/\.(exe|cmd|bat)$/, "") === "gh";
}

/** @type {(ctx: CliContext) => Promise<CliReading>} */
async function readCopilot({ bin, run }) {
  if (!isGitHubCli(bin)) return { signedIn: null, detail: "COPILOT_BIN is a custom command; Kumo can't read its sign-in." };
  const res = await run(["auth", "status", "--hostname", "github.com"]);
  if (res.timedOut) return { signedIn: null, detail: "Timed out reading the sign-in status." };
  if (res.code !== 0) return { signedIn: false, detail: "Not signed in to GitHub CLI." };
  const who = /Logged in to \S+ account (\S+)/.exec(`${res.stdout}\n${res.stderr}`);
  return {
    signedIn: true,
    account: who ? plainText(who[1], 60) || null : null,
    detail:
      "Signed in to GitHub CLI; Copilot needs a GitHub Copilot plan. Kumo does not sign out here: " +
      "it would sign you out of GitHub CLI everywhere.",
  };
}

// Each entry's commands were checked with `--help` on this machine, unless `null`.
/** @type {Record<string, CliProvider>} */
const CLI_PROVIDERS = {
  claude: {
    command: "claude",
    binary: findClaudeBinary,
    // `claude auth --help`: login, logout, status.
    signIn: ["auth", "login"],
    signOut: ["auth", "logout"],
    read: readClaude,
  },
  codex: {
    command: "codex",
    binary: findCodexBinary,
    // `codex login --help` (a bare `codex login` signs in with ChatGPT; `status` reads), `codex logout --help`.
    signIn: ["login"],
    signOut: ["logout"],
    read: readCodex,
  },
  antigravity: {
    command: "agy",
    binary: getCliBinary,
    // `agy --help` lists no login or logout command; the first interactive run asks to sign in.
    signIn: [],
    signOut: null,
    noSignOut: "agy has no sign-out command. Sign out from inside agy.",
    read: readAntigravity,
  },
  copilot: {
    command: "gh",
    binary: findCopilotBinary,
    // `gh auth --help`: login, logout, status. Logout would end the whole GitHub CLI login, so it is not offered.
    signIn: ["auth", "login"],
    signOut: null,
    noSignOut: "Signing out of Copilot means signing out of GitHub CLI entirely, so Kumo does not offer it. Run `gh auth logout` yourself if you mean to.",
    noSignInFor: (bin) => (isGitHubCli(bin) ? null : "COPILOT_BIN is a custom command; Kumo does not know its sign-in command."),
    read: readCopilot,
  },
  cursor: {
    command: "cursor-agent",
    binary: findCursorBinary,
    // Not installed on the machine this table was verified on, and its worker documents no auth command.
    signIn: null,
    signOut: null,
    noSignIn: "Kumo does not know a Cursor Agent sign-in command it can run.",
    noSignOut: "Kumo does not know a Cursor Agent sign-out command it can run.",
    read: async () => unreadable("Cursor Agent"),
  },
  opencode: {
    command: "opencode",
    binary: findOpencodeBinary,
    signIn: null,
    signOut: null,
    noSignIn: "Kumo does not know an OpenCode sign-in command it can run.",
    noSignOut: "Kumo does not know an OpenCode sign-out command it can run.",
    read: async () => unreadable("OpenCode"),
  },
  commandcode: {
    command: "commandcode",
    binary: findCommandcodeBinary,
    signIn: null,
    signOut: null,
    noSignIn: "Kumo does not know a CommandCode sign-in command it can run.",
    noSignOut: "Kumo does not know a CommandCode sign-out command it can run.",
    read: async () => unreadable("CommandCode"),
  },
};

/**
 * @param {string} provider
 * @param {CliProvider} def
 * @returns {Promise<AccountStatus>}
 */
async function probeCli(provider, def) {
  const status = blankStatus(provider, "subscription");
  const bin = def.binary();
  /** @param {string[]} args */
  const run = (args) => deps.run(provider, bin, args);
  const [versionRun, reading] = await Promise.all([
    run(["--version"]),
    // The reading starts now, and is ignored below when the CLI turns out not to exist.
    def.read({ bin, run }),
  ]);

  status.installed = isInstalled(bin, versionRun);
  status.version = parseVersion(versionRun);
  if (!status.installed) {
    status.signedIn = false;
    status.detail = `${def.command} not found`;
    return status;
  }
  status.signedIn = reading.signedIn;
  status.account = reading.account ?? null;
  status.plan = reading.plan ?? null;
  status.detail = reading.detail;
  status.canSignIn = def.signIn !== null && !def.noSignInFor?.(bin);
  status.canSignOut = def.signOut !== null && reading.signedIn === true;
  return status;
}

// ── Ollama and the direct APIs ──

/**
 * Where Ollama listens, as its own client resolves OLLAMA_HOST: a bare
 * `host:port`, a bare `host` or a full URL, defaulting to http://127.0.0.1:11434.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null} null when OLLAMA_HOST is not an address
 */
export function ollamaBaseUrl(env = process.env) {
  const raw = String(env.OLLAMA_HOST ?? "").trim();
  if (!raw) return "http://127.0.0.1:11434";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
    // 0.0.0.0 and :: are where a server binds, not somewhere a client can connect.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "0.0.0.0" || host === "::") url.hostname = "127.0.0.1";
    if (!url.port && url.protocol === "http:") url.port = "11434";
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * GET a JSON document with a deadline. Redirects are not followed: a request
 * that may carry a key goes only where the caller pointed it.
 *
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs: number }} opts
 * @returns {Promise<{ status: number, json: unknown } | { error: string, timedOut: boolean }>}
 */
async function getJson(url, { headers = {}, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "manual",
      signal: controller.signal,
    });
    /** @type {unknown} */
    let json = null;
    if (res.ok) {
      try {
        json = JSON.parse(await readBoundedText(res));
      } catch (err) {
        if (controller.signal.aborted) throw err;
        /* a 200 that is not JSON: `json` stays null and the caller says so */
      }
    }
    return { status: res.status, json };
  } catch (err) {
    if (controller.signal.aborted) return { error: "no answer in time", timedOut: true };
    // The network error's code (ECONNREFUSED, ENOTFOUND, …); other messages can quote the URL, so are not passed on.
    const cause = /** @type {{ code?: unknown }} */ (err instanceof Error && err.cause ? err.cause : {});
    return { error: typeof cause.code === "string" ? cause.code : "request failed", timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask a local Ollama server for its models.
 *
 * Over HTTP, never `ollama list`: the CLI starts a server when none is
 * running, and checking an account must not start anything.
 *
 * @param {string} base
 * @param {number} timeoutMs
 * @returns {Promise<{ up: boolean, status?: number, models: string[], error?: string, timedOut?: boolean }>}
 */
async function readOllama(base, timeoutMs) {
  const res = await getJson(`${base}/api/tags`, { timeoutMs });
  if ("error" in res) return { up: false, models: [], error: res.error, timedOut: res.timedOut };
  if (res.status < 200 || res.status >= 300) return { up: false, status: res.status, models: [] };
  const list = /** @type {any} */ (res.json)?.models;
  const models = Array.isArray(list)
    ? list.map((m) => (typeof m?.name === "string" ? m.name : null)).filter((n) => typeof n === "string")
    : [];
  return { up: true, status: res.status, models: [...new Set(/** @type {string[]} */ (models))].slice(0, MAX_ENDPOINT_MODELS) };
}

/** @returns {Promise<AccountStatus>} */
async function probeOllama() {
  const status = blankStatus("ollama", "local");
  const bin = findOllamaBinary();
  const base = ollamaBaseUrl();
  status.baseUrl = base ? displayUrl(base) : null;
  const [versionRun, server] = await Promise.all([
    deps.run("ollama", bin, ["--version"]),
    base ? readOllama(base, LOCAL_SERVER_TIMEOUT_MS) : Promise.resolve(null),
  ]);

  status.installed = isInstalled(bin, versionRun);
  status.version = parseVersion(versionRun);
  if (!status.installed) {
    status.signedIn = false;
    status.detail = "ollama not found";
    return status;
  }
  if (!base || !server) {
    status.signedIn = false;
    status.detail = "OLLAMA_HOST is not a valid address.";
  } else if (server.up) {
    status.signedIn = true;
    status.detail = `Running at ${status.baseUrl}.`;
  } else {
    status.signedIn = false;
    status.detail = `Installed, but no server answers at ${status.baseUrl}. Start the Ollama app, or run: ollama serve`;
  }
  return status;
}

/**
 * The direct API providers: "signed in" means the key is in the environment.
 *
 * @type {Record<string, string[]>}
 */
const API_KEY_VARS = {
  "openai-api": ["OPENAI_API_KEY"],
  "anthropic-api": ["ANTHROPIC_API_KEY"],
  "gemini-api": ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
};

/**
 * @param {string} provider
 * @returns {AccountStatus}
 */
function probeApiKey(provider) {
  const status = blankStatus(provider, "api");
  status.installed = true;
  const names = API_KEY_VARS[provider];
  const found = names.find(hasEnv);
  status.envVar = found ?? names[0];
  status.signedIn = Boolean(found);
  status.detail = found ? `${found} is set.` : `${names[0]} is not set.`;
  return status;
}

/** @returns {AccountStatus} */
function probeCompat() {
  const status = blankStatus("compat-api", "api");
  status.installed = true;
  status.envVar = "COMPAT_BASE_URL";
  // The same order the transport uses: the saved URL, then the variable.
  const url = String(loadConfig().compatBaseUrl ?? "").trim() || String(process.env.COMPAT_BASE_URL ?? "").trim();
  const keyNote = hasEnv("COMPAT_API_KEY") ? "COMPAT_API_KEY is set." : "No COMPAT_API_KEY (keyless).";
  if (!url) {
    status.signedIn = false;
    status.detail = "No base URL. Set the base URL, or the COMPAT_BASE_URL variable.";
  } else if (!isSafeBaseUrl(url)) {
    status.signedIn = false;
    status.baseUrl = displayUrl(url);
    status.detail = "The base URL must be https, or plain http to localhost.";
  } else {
    status.signedIn = true;
    status.baseUrl = displayUrl(url);
    status.detail = `Endpoint set. ${keyNote}`;
  }
  return status;
}

// ── The list ──

/** @type {Map<string, { at: number, value: AccountStatus }>} */
const cache = new Map();
/** @type {Map<string, Promise<AccountStatus>>} */
const inflight = new Map();
/**
 * The probe whose answer a provider's cache entry may take: the newest one.
 *
 * @type {Map<string, object>}
 */
const newest = new Map();

/**
 * Drop what is held for one provider, and disown any probe still running
 * for it (its answer, when it comes, is not kept).
 *
 * @param {string} provider
 */
function forget(provider) {
  cache.delete(provider);
  inflight.delete(provider);
  newest.delete(provider);
}

/** Test seam: forget every cached probe. */
export function clearAccountCache() {
  cache.clear();
  inflight.clear();
  newest.clear();
}

/**
 * @param {string} provider
 * @returns {Promise<AccountStatus>}
 */
async function probe(provider) {
  if (Object.hasOwn(CLI_PROVIDERS, provider)) return probeCli(provider, CLI_PROVIDERS[provider]);
  if (provider === "ollama") return probeOllama();
  if (provider === "compat-api") return probeCompat();
  if (Object.hasOwn(API_KEY_VARS, provider)) return probeApiKey(provider);
  throw new Error(`No account probe for '${provider}'.`);
}

/**
 * One provider's status, probed now: each probe has its own timeout, and the
 * deadline here means no provider can hold the whole list past it.
 *
 * The deadline's answer ("Timed out") only stands in for the one caller that
 * waited: it is not kept, so the next ask probes again, and the probe's real
 * answer replaces it in the cache if it still arrives.
 *
 * @param {string} provider
 * @returns {Promise<AccountStatus>}
 */
function probeNow(provider) {
  const mine = {};
  newest.set(provider, mine);
  /** @type {Promise<AccountStatus>} */
  const real = probe(provider).catch((err) => {
    const status = blankStatus(provider, kindOf(provider));
    status.detail = `Could not check ${status.name}: ${errorMessage(err)}`;
    return status;
  });
  /** @type {Promise<AccountStatus>} */
  const answer = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (inflight.get(provider) === answer) inflight.delete(provider);
      const status = blankStatus(provider, kindOf(provider));
      status.detail = `Timed out checking ${status.name}.`;
      resolve(status);
    }, deps.deadlineMs);
    real.then((status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  inflight.set(provider, answer);
  real.then((value) => {
    // Only the newest probe's answer is kept (a sign-out may have started another).
    if (newest.get(provider) !== mine) return;
    cache.set(provider, { at: Date.now(), value });
    if (inflight.get(provider) === answer) inflight.delete(provider);
  });
  return answer;
}

/** @param {string} provider @returns {AccountKind} */
function kindOf(provider) {
  if (provider === "ollama") return "local";
  if (Object.hasOwn(API_KEY_VARS, provider) || provider === "compat-api") return "api";
  return "subscription";
}

/**
 * @param {string} provider
 * @param {boolean} refresh
 * @returns {Promise<AccountStatus>}
 */
function statusFor(provider, refresh) {
  if (!refresh) {
    const hit = cache.get(provider);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);
    const pending = inflight.get(provider);
    if (pending) return pending;
  }
  return probeNow(provider);
}

/**
 * The status of every provider Kumo knows, in `ALLOWED_PROVIDERS` order.
 * Results are kept for 30 seconds; `refresh` probes again.
 *
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<AccountStatus[]>}
 */
export function listAccounts({ refresh = false } = {}) {
  return Promise.all(ALLOWED_PROVIDERS.map((provider) => statusFor(provider, refresh)));
}

/**
 * One provider's status, from the same cache {@link listAccounts} fills and
 * probed only when that holds nothing fresh for it.
 *
 * @param {string} provider
 * @returns {Promise<AccountStatus>}
 */
export function accountStatus(provider) {
  return statusFor(requireProvider(provider), false);
}

/**
 * The last status read of a provider while it is still fresh, or null when
 * none was read lately. Never probes.
 *
 * @param {string} provider
 * @returns {AccountStatus | null}
 */
export function cachedAccountStatus(provider) {
  const hit = cache.get(canonicalizeProvider(provider));
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : null;
}

/** @type {Set<(provider: string) => void>} */
const signOutListeners = new Set();

/**
 * Be told when a provider is signed out through {@link signOut}, so what is
 * held for that account (a session's quota figures) can go with it.
 *
 * @param {(provider: string) => void} listener
 * @returns {() => void} removes the listener
 */
export function onSignedOut(listener) {
  signOutListeners.add(listener);
  return () => void signOutListeners.delete(listener);
}

/**
 * @param {string} provider
 * @returns {string} the canonical id
 */
function requireProvider(provider) {
  const id = canonicalizeProvider(provider);
  if (!ALLOWED_PROVIDERS.includes(id)) {
    throw new Error(`Unknown provider '${String(provider).slice(0, 60)}'. Known: ${ALLOWED_PROVIDERS.join(", ")}`);
  }
  return id;
}

/** @param {string} bin the argument, as launchTerminalCommand would validate it */
function launchable(bin) {
  return /^[A-Za-z0-9._:\\/=@+-]+$/.test(bin);
}

/**
 * Open a terminal running the provider's own login command. Credentials are
 * typed into that CLI, never into Kumo.
 *
 * @param {string} provider
 * @returns {Promise<SignInResult>}
 */
export async function signIn(provider) {
  const id = requireProvider(provider);
  const def = Object.hasOwn(CLI_PROVIDERS, id) ? CLI_PROVIDERS[id] : null;
  const name = providerDisplayName(id);
  if (!def || def.signIn === null) {
    throw new Error(def?.noSignIn ?? `${name} signs in with an environment variable or no account at all; there is nothing to launch.`);
  }
  const bin = def.binary();
  // Not a command whose login Kumo knows (a custom COPILOT_BIN is not `gh`).
  const refused = def.noSignInFor?.(bin);
  if (refused) throw new Error(refused);
  // The resolved path when it can go on a command line as it is, else the bare name from the table.
  const exe = path.isAbsolute(bin) && launchable(bin) ? bin : def.command;
  const launched = await deps.launch([exe, ...def.signIn], {
    cwd: os.homedir(),
    title: `Kumo ${name} sign-in`.replace(/[^A-Za-z0-9 ._-]/g, ""),
    // The terminal gets the provider's own scrubbed environment, like every other child Kumo starts.
    env: childEnvFor(id),
  });
  return { launched, command: [def.command, ...def.signIn].join(" ") };
}

/**
 * Run the provider's logout command (no terminal) and return its fresh status.
 *
 * @param {string} provider
 * @returns {Promise<AccountStatus>}
 */
export async function signOut(provider) {
  const id = requireProvider(provider);
  const def = Object.hasOwn(CLI_PROVIDERS, id) ? CLI_PROVIDERS[id] : null;
  const name = providerDisplayName(id);
  if (!def || def.signOut === null) {
    throw new Error(def?.noSignOut ?? `${name} has no account to sign out of; remove its key from the environment instead.`);
  }
  const command = [def.command, ...def.signOut].join(" ");
  try {
    const res = await deps.run(id, def.binary(), def.signOut, SIGN_OUT_TIMEOUT_MS);
    if (!res.started) throw new Error(`Could not run \`${command}\`: ${def.command} was not found.`);
    if (res.timedOut) throw new Error(`\`${command}\` did not finish within ${SIGN_OUT_TIMEOUT_MS / 1000}s.`);
    if (res.code !== 0) throw new Error(`\`${command}\` failed (exit code ${res.code}).`);
  } finally {
    // Whatever happened, the old answer may be wrong now.
    forget(id);
  }
  // The logout worked: the old account's quota is not the next one's.
  dropProviderQuotas(id);
  for (const listener of [...signOutListeners]) {
    try {
      listener(id);
    } catch (err) {
      console.error(`[kumo] sign-out listener failed: ${errorMessage(err)}`);
    }
  }
  return statusFor(id, true);
}

// ── Endpoint tests ──

/**
 * @param {string} text
 * @param {string | null} secret
 */
function redact(text, secret) {
  return secret ? text.split(secret).join("[REDACTED]") : text;
}

/** @param {number} n @param {string} noun */
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Why a base URL may not be requested, or null. https, or plain http to
 * loopback, so a key never crosses the network in the clear; and no embedded
 * credentials, which a result would otherwise echo back.
 *
 * @param {string} raw
 * @returns {string | null}
 */
function baseUrlProblem(raw) {
  if (!isSafeBaseUrl(raw)) return "it must be https, or plain http to localhost";
  const url = new URL(raw);
  if (url.username || url.password) return "it must not contain a user name or password";
  return null;
}

/**
 * Check that an endpoint answers. A base URL from outside must pass
 * {@link baseUrlProblem}; the key is sent only when COMPAT_API_KEY is set, and
 * never appears in a result.
 *
 * @param {{ provider: string, baseUrl?: string }} args
 * @returns {Promise<EndpointTest>}
 */
export async function testEndpoint({ provider, baseUrl }) {
  if (provider === "ollama") {
    const explicit = baseUrl?.trim();
    const refused = explicit ? baseUrlProblem(explicit) : null;
    if (refused) throw new Error(`Refusing that URL: ${refused}.`);
    const base = explicit ? displayUrl(explicit) : ollamaBaseUrl();
    if (!base) return { ok: false, detail: "OLLAMA_HOST is not a valid address.", models: [] };
    const res = await readOllama(base, ENDPOINT_TIMEOUT_MS);
    if (res.up) return { ok: true, detail: `Ollama answered at ${base}: ${count(res.models.length, "model")}.`, models: res.models };
    if (res.status) return { ok: false, detail: `Ollama at ${base} answered HTTP ${res.status}.`, models: [] };
    return {
      ok: false,
      detail: res.timedOut
        ? `No answer from ${base} within ${ENDPOINT_TIMEOUT_MS / 1000}s.`
        : `No answer from Ollama at ${base} (${res.error}). Start the Ollama app, or run: ollama serve`,
      models: [],
    };
  }

  if (provider !== "compat-api") throw new Error(`Only ollama and compat-api have an endpoint to test, not '${String(provider).slice(0, 60)}'.`);

  const explicit = baseUrl?.trim();
  const refused = explicit ? baseUrlProblem(explicit) : null;
  if (refused) throw new Error(`Refusing that URL: ${refused}.`);
  const raw = explicit || String(loadConfig().compatBaseUrl ?? "").trim() || String(process.env.COMPAT_BASE_URL ?? "").trim();
  if (!raw) return { ok: false, detail: "No base URL is set. Enter one, or set COMPAT_BASE_URL.", models: [] };
  // A saved or environment URL that fails is reported, not thrown: the person testing did not type it.
  const saved = explicit ? null : baseUrlProblem(raw);
  if (saved) return { ok: false, detail: `The configured base URL is not allowed: ${saved}.`, models: [] };
  const shown = displayUrl(raw) ?? "the endpoint";
  const key = hasEnv("COMPAT_API_KEY") ? String(process.env.COMPAT_API_KEY).trim() : null;
  const res = await getJson(`${raw.replace(/\/+$/, "")}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    timeoutMs: ENDPOINT_TIMEOUT_MS,
  });

  if ("error" in res) {
    const detail = res.timedOut
      ? `No answer from ${shown} within ${ENDPOINT_TIMEOUT_MS / 1000}s.`
      : `Could not reach ${shown} (${res.error}).`;
    return { ok: false, detail: redact(detail, key), models: [] };
  }
  if (res.status === 401 || res.status === 403) {
    const sent = key ? "COMPAT_API_KEY was sent." : "No COMPAT_API_KEY is set.";
    return { ok: false, detail: `${shown} rejected the credentials (HTTP ${res.status}). ${sent}`, models: [] };
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, detail: `${shown} redirected the request (HTTP ${res.status}); use the URL it redirects to.`, models: [] };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, detail: `${shown} answered GET /models with HTTP ${res.status}.`, models: [] };
  }
  // OpenAI-style `{ data: [{ id }] }`; a bare array of the same is accepted too.
  const body = /** @type {any} */ (res.json);
  const list = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(list)) {
    return { ok: false, detail: `${shown} answered, but not with an OpenAI-style model list.`, models: [] };
  }
  const ids = [
    ...new Set(
      list
        .map((m) => (typeof m === "string" ? m : m?.id))
        .filter((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
    ),
  ].slice(0, MAX_ENDPOINT_MODELS);
  return { ok: true, detail: `Reached ${shown}: ${count(ids.length, "model")} listed.`, models: ids };
}
