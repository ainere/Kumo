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
 * doctor.js — System health for Settings › Doctor.
 *
 * `runDoctor` probes the machine and returns a flat list of checks, grouped
 * for display. Probes are independent, run in parallel and each has a
 * deadline, so one hung CLI cannot stall the whole run. Nothing here changes
 * user state: a corrupt config.json is reported, never quarantined (loadConfig
 * would move it aside, so it is only called once the file is known to parse).
 *
 * `repairDoctor` runs one of a few safe, idempotent repairs. None deletes a
 * user file, touches a credential or resets a setting. Anything that looks
 * inside a workspace or writes for one is limited to a registered project or a
 * folder a session has open; the renderer cannot point it at any other folder.
 *
 * `doctorReport` renders the checks as Markdown that is safe to paste into a
 * public issue: the home directory, account name, email addresses, cookies,
 * URL credentials and secret-looking values are scrubbed, and no environment
 * variable value is ever written.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { VERSION } from "../version.js";
import { configFile, kumoHome } from "../config/paths.js";
import { DEFAULT_CONFIG, loadConfig } from "../config/settings.js";
import {
  BUILTIN_ROLES,
  activeTargets,
  emptyRoles,
  listRoles,
  resolveRoleTarget,
  sanitizeRoles,
  sharedWorker,
} from "../config/roles.js";
import { canonicalizeProvider } from "../config/models.js";
import { BRIDGE_SERVER_PATH, ensureAntigravityBridgeConfig } from "../config/sync.js";
import { getCliBinary, clearCliBinaryCache } from "../bridge/agy-runner.js";
import { findCodexBinary } from "../providers/orchestrators/codex.js";
import { SECRET_ENV_RE, childEnvFor, clearBinaryCache, resolveBinary } from "../utils/process.js";
import { checkCommandFile, probeBridge } from "../utils/diagnostics.js";
import { getLiveLogDir, hashWorkspace, isRegisteredProject, pruneLiveLogs } from "../data/sessions.js";
import { EngineIpcServer } from "./ipc/engine-server.js";
import { nodeCommand } from "./node-command.js";

/**
 * @typedef {{
 *   id: string,
 *   group: "runtime"|"providers"|"bridge"|"permissions",
 *   label: string,
 *   status: "ok"|"warn"|"fail",
 *   detail: string,
 *   repair: { id: string, label: string } | null,
 * }} DoctorCheck
 */

/**
 * config.json as found on disk, read without side effects.
 *
 * @typedef {{
 *   state: "ok"|"missing"|"invalid",
 *   file: string,
 *   error?: string,
 *   parsed?: Record<string, any>,
 * }} ConfigState
 */

/**
 * @typedef {{
 *   provider: string,
 *   label: string,
 *   args: string[],
 *   bin: (config: ConfigState) => string,
 *   hint: string,
 *   onlyWhenUsed?: boolean,
 * }} CliProvider
 */

/** Node the engine needs; mirrors package.json `engines`. */
const MIN_NODE_MAJOR = 22;

/** One `--version` probe. */
const CLI_TIMEOUT_MS = 8000;
/** Bridge start plus `tools/list`; a cold start imports the SDK and every provider. */
const BRIDGE_TIMEOUT_MS = 9000;
/** A probe's deadline is its own limit plus this, so its own timeout reports first. */
const DEADLINE_SLACK_MS = 2000;

/** Same cutoff as pruneLiveLogs' default. */
const LIVE_LOG_MAX_AGE_MS = 24 * 3600 * 1000;
/** Kumo prunes stale live logs on every worker run, so a few are normal. */
const STALE_LOGS_WARN_COUNT = 25;

/** Direct-API providers and the environment variables that authenticate each. */
const API_KEYS = {
  "openai-api": ["OPENAI_API_KEY"],
  "anthropic-api": ["ANTHROPIC_API_KEY"],
  "gemini-api": ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
};

/** Orchestrators that can call worker tools (see `delegates` in the orchestrator registry). */
const DELEGATING_LEADS = new Set(["codex", "antigravity", "claude"]);

/** @type {CliProvider[]} */
const CLI_PROVIDERS = [
  {
    provider: "claude",
    label: "Claude Code",
    args: ["--version"],
    bin: () => process.env.CLAUDE_BIN || "claude",
    hint: "Install it with: npm install -g @anthropic-ai/claude-code, then run claude once to log in.",
  },
  {
    provider: "codex",
    label: "Codex",
    args: ["--version"],
    bin: () => findCodexBinary(),
    hint: "Install it with: npm install -g @openai/codex, then run: codex login",
  },
  {
    provider: "antigravity",
    label: "Antigravity (agy)",
    args: ["--version"],
    bin: (config) => agyBinary(config),
    hint: "Install the Antigravity CLI (agy) and sign in with your Google account.",
  },
  {
    provider: "gemini-cli",
    label: "Gemini CLI",
    args: ["--version"],
    bin: () => process.env.GEMINI_BIN || "gemini",
    hint: "Install it with: npm install -g @google/gemini-cli",
  },
  {
    provider: "copilot",
    label: "GitHub Copilot CLI",
    args: ["copilot", "--version"],
    bin: () => process.env.COPILOT_BIN || "gh",
    hint: "Install the GitHub CLI and its Copilot extension: gh extension install github/gh-copilot",
  },
  {
    provider: "cursor",
    label: "Cursor Agent",
    args: ["--version"],
    bin: () => process.env.CURSOR_BIN || "cursor-agent",
    hint: "Install Cursor Agent and make sure 'cursor-agent' is on PATH.",
  },
  {
    provider: "ollama",
    label: "Ollama",
    args: ["--version"],
    bin: () => process.env.OLLAMA_BIN || "ollama",
    hint: "Install Ollama from https://ollama.com and make sure 'ollama' is on PATH.",
  },
  {
    provider: "opencode",
    label: "OpenCode",
    args: ["--version"],
    bin: () => process.env.OPENCODE_BIN || "opencode",
    hint: "Install the OpenCode CLI and make sure 'opencode' is on PATH.",
    onlyWhenUsed: true,
  },
  {
    provider: "commandcode",
    label: "CommandCode",
    args: ["--version"],
    bin: () => process.env.COMMANDCODE_BIN || "commandcode",
    hint: "Install the CommandCode CLI and make sure 'commandcode' is on PATH.",
    onlyWhenUsed: true,
  },
];

const clearCacheRepair = () => ({ id: "clear-binary-cache", label: "Re-scan for installed CLIs" });
const bridgeConfigRepair = () => ({ id: "antigravity-bridge-config", label: "Write the kumo-bridge entry" });
const pruneLogsRepair = () => ({ id: "prune-live-logs", label: "Remove stale worker logs" });

// ── helpers ──

/**
 * @param {string} id
 * @param {DoctorCheck["group"]} group
 * @param {string} label
 * @param {DoctorCheck["status"]} status
 * @param {string} detail
 * @param {DoctorCheck["repair"]} [repair]
 * @returns {DoctorCheck}
 */
function mk(id, group, label, status, detail, repair = null) {
  return { id, group, label, status, detail, repair };
}

/** @param {unknown} err */
function errMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @param {unknown} err */
function errCode(err) {
  return /** @type {NodeJS.ErrnoException} */ (err)?.code;
}

/**
 * @param {unknown} value
 * @returns {string|undefined} an absolute path, or undefined when none was given
 */
function cleanWorkspace(value) {
  return typeof value === "string" && value.trim() !== "" ? path.resolve(value.trim()) : undefined;
}

/**
 * Whether Doctor may look inside, and write for, this folder: a registered
 * project, or a folder a session has open. Any other folder the renderer names
 * is left alone.
 *
 * @param {string} workspace
 * @param {string[]} [openWorkspaces] - folders sessions have open
 * @returns {boolean}
 */
function workspaceKnown(workspace, openWorkspaces = []) {
  if (isRegisteredProject(workspace)) return true;
  const key = hashWorkspace(workspace);
  return openWorkspaces.some((open) => typeof open === "string" && open !== "" && hashWorkspace(open) === key);
}

/** @param {string} workspace */
function unknownWorkspaceDetail(workspace) {
  return `${workspace} is not a Kumo project and no session has it open, so Doctor does not look inside it or change files there. Open the folder in Kumo first.`;
}

/**
 * @param {string} workspace
 * @returns {string|null} why the folder cannot hold workspace files, or null
 */
function workspaceProblem(workspace) {
  try {
    return fs.statSync(workspace).isDirectory() ? null : `${workspace} is not a folder.`;
  } catch {
    return `The workspace folder ${workspace} does not exist.`;
  }
}

/** @param {string[]} items */
function joinList(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** @param {string} text */
function firstLine(text) {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line ? line.slice(0, 120) : "version unknown";
}

/** @param {string} name */
function hasEnv(name) {
  return typeof process.env[name] === "string" && process.env[name].trim() !== "";
}

/**
 * Run one probe with a deadline. A probe that throws or hangs becomes a failed
 * check instead of taking the run down.
 *
 * @param {{ id: string, group: DoctorCheck["group"], label: string }} meta
 * @param {() => DoctorCheck | DoctorCheck[] | Promise<DoctorCheck | DoctorCheck[]>} fn
 * @param {number} [limitMs]
 * @returns {Promise<DoctorCheck[]>}
 */
async function guarded(meta, fn, limitMs = 5000) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(limitMs / 1000)}s`)), limitMs);
      }),
    ]);
    return Array.isArray(result) ? result : [result];
  } catch (err) {
    return [mk(meta.id, meta.group, meta.label, "fail", `This check could not run: ${errMessage(err)}`)];
  } finally {
    clearTimeout(timer);
  }
}

// ── configuration, read without side effects ──

/** @returns {ConfigState} */
function readConfigState() {
  const file = configFile();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return { state: "missing", file };
    return { state: "invalid", file, error: `cannot be read (${errCode(err) || errMessage(err)})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { state: "invalid", file, error: `is not valid JSON (${errMessage(err)})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "invalid", file, error: "must hold a JSON object" };
  }
  return { state: "ok", file, parsed };
}

/**
 * The settings the saved defaults give. loadConfig moves a file it cannot
 * parse aside, so it only runs once the file is known to parse; otherwise the
 * defaults stand in and the config check reports the problem.
 *
 * @param {ConfigState} state
 * @returns {Record<string, any>}
 */
function effectiveConfig(state) {
  if (state.state === "ok") {
    try {
      return loadConfig();
    } catch {
      /* fall back to defaults; the other checks surface the cause */
    }
  }
  return { ...DEFAULT_CONFIG, roles: emptyRoles() };
}

/**
 * The binary Antigravity runs. getCliBinary reads the config through
 * loadConfig, which would quarantine a corrupt file, so that case goes by name.
 *
 * @param {ConfigState} config
 * @returns {string}
 */
function agyBinary(config) {
  if (config.state === "invalid") return process.env.AGY_BIN || "agy";
  return getCliBinary();
}

/**
 * Which roles run on each provider, as people name them.
 *
 * @param {Record<string, any>} config
 * @returns {Map<string, string[]>}
 */
function providerUsage(config) {
  /** @type {Map<string, string[]>} */
  const usage = new Map();
  for (const target of activeTargets(config)) {
    const who =
      target.role === "orchestrator" ? "the lead" : target.role === "worker" ? "the shared worker" : `the ${target.role} role`;
    usage.set(target.provider, [...(usage.get(target.provider) || []), who]);
  }
  return usage;
}

// ── runtime ──

function nodeCheck() {
  const major = Number(process.versions.node.split(".")[0]);
  const electron = process.versions.electron;
  const runtime = electron
    ? `Electron ${electron} with its bundled Node ${process.versions.node}`
    : `Node ${process.versions.node}`;
  return major >= MIN_NODE_MAJOR
    ? mk("node-version", "runtime", "Node.js runtime", "ok", runtime)
    : mk("node-version", "runtime", "Node.js runtime", "fail", `${runtime}. Kumo needs Node ${MIN_NODE_MAJOR} or newer.`);
}

/** @param {Record<string, any>} config */
async function gitCheck(config) {
  const res = await checkCommandFile("git", ["--version"], { timeoutMs: CLI_TIMEOUT_MS, env: childEnvFor("git") });
  if (res.ok) return mk("git", "runtime", "Git", "ok", firstLine(res.output));
  // Diff review is the default safety mode and cannot work without git.
  const status = config.safetyMode === "diff-review" ? "fail" : "warn";
  return mk(
    "git",
    "runtime",
    "Git",
    status,
    `Git was not found (${res.error}). Kumo uses it to preview and apply worker diffs and to see what a worker changed.`,
    clearCacheRepair()
  );
}

function kumoHomeCheck() {
  const dir = kumoHome();
  const make = (/** @type {DoctorCheck["status"]} */ status, /** @type {string} */ detail) =>
    mk("kumo-home", "runtime", "Kumo data folder", status, detail);
  try {
    if (!fs.existsSync(dir)) {
      // Creating it here would be a side effect; its nearest parent must accept it.
      let parent = path.dirname(dir);
      while (!fs.existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
      fs.accessSync(parent, fs.constants.W_OK);
      return make("ok", `${dir} does not exist yet; Kumo creates it on first use.`);
    }
    const probe = path.join(dir, `.doctor-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(probe, "ok");
    } finally {
      fs.rmSync(probe, { force: true });
    }
    return make("ok", `${dir} is writable.`);
  } catch (err) {
    return make(
      "fail",
      `${dir} is not writable (${errMessage(err)}). Kumo keeps settings, chats and logs there; set KUMO_HOME to a folder you can write to.`
    );
  }
}

/** @param {ConfigState} state */
function configCheck(state) {
  const make = (/** @type {DoctorCheck["status"]} */ status, /** @type {string} */ detail) =>
    mk("config-file", "runtime", "Kumo config", status, detail);
  if (state.state === "missing") {
    return make("ok", `No config file yet at ${state.file}; Kumo runs on its defaults and writes one on the first setting change.`);
  }
  if (state.state === "invalid") {
    // No repair: the only fix is to discard the user's settings, which is theirs to decide.
    return make(
      "fail",
      `${state.file} ${state.error}. Kumo moves a file like this aside as config.json.corrupt.<time> and starts from defaults the next time it loads settings. Doctor left it as it is.`
    );
  }
  const { problems } = sanitizeRoles(state.parsed?.roles);
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).map((p) => p.slice(0, 160));
    return make(
      "warn",
      `${state.file} parses, but ${problems.length} role setting${problems.length > 1 ? "s are" : " is"} ignored: ${shown.join("; ")}`
    );
  }
  return make("ok", `${state.file} parses.`);
}

/** @param {string} workspace */
function scanLiveLogs(workspace) {
  const dir = getLiveLogDir(workspace);
  const cutoff = Date.now() - LIVE_LOG_MAX_AGE_MS;
  let total = 0;
  let stale = 0;
  let staleBytes = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("live-") || !name.endsWith(".log")) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      total++;
      if (st.mtimeMs < cutoff) {
        stale++;
        staleBytes += st.size;
      }
    } catch {
      /* removed while scanning */
    }
  }
  return { total, stale, staleBytes };
}

/** @param {string} workspace */
function liveLogsCheck(workspace) {
  const label = "Worker live logs";
  const problem = workspaceProblem(workspace);
  if (problem) return mk("live-logs", "runtime", label, "warn", problem);
  const { total, stale, staleBytes } = scanLiveLogs(workspace);
  if (stale >= STALE_LOGS_WARN_COUNT) {
    const mb = Math.max(1, Math.round(staleBytes / (1024 * 1024)));
    return mk(
      "live-logs",
      "runtime",
      label,
      "warn",
      `${stale} worker log files are over a day old (about ${mb} MB) in this workspace's live-log folder.`,
      pruneLogsRepair()
    );
  }
  return mk(
    "live-logs",
    "runtime",
    label,
    "ok",
    `${total} worker log file${total === 1 ? "" : "s"}, ${stale} over a day old. Kumo prunes old ones on each worker run.`
  );
}

// ── providers ──

/**
 * @param {CliProvider} spec
 * @param {string[]} usedBy
 * @param {ConfigState} config
 * @returns {Promise<DoctorCheck>}
 */
async function cliCheck(spec, usedBy, config) {
  const id = `provider-${spec.provider}`;
  const bin = spec.bin(config);
  // Only this provider's own credentials reach the CLI being probed.
  const res = await checkCommandFile(bin, spec.args, { timeoutMs: CLI_TIMEOUT_MS, env: childEnvFor(spec.provider) });
  if (res.ok) {
    const resolved = resolveBinary(bin);
    const where = path.isAbsolute(resolved) ? ` at ${resolved}` : "";
    return mk(id, "providers", spec.label, "ok", `${firstLine(res.output)}${where}`);
  }
  const command = `${path.basename(bin)} ${spec.args.join(" ")}`;
  const why = /ENOENT/.test(res.error || "")
    ? `not found${path.isAbsolute(bin) ? "" : " on PATH"}`
    : res.error === "timed out"
      ? `did not answer '${command}' in time`
      : /^exit code/.test(res.error || "")
        ? `was found, but '${command}' failed (${res.error})`
        : `could not be started (${res.error})`;
  const status = usedBy.length > 0 ? "fail" : "warn";
  const context = usedBy.length > 0 ? ` ${capitalize(joinList(usedBy))} use${usedBy.length === 1 ? "s" : ""} it.` : " No configured role uses it.";
  return mk(id, "providers", spec.label, status, `'${path.basename(bin)}' ${why}.${context} ${spec.hint}`, clearCacheRepair());
}

/** @param {string} s */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {Map<string, string[]>} usage
 * @param {Record<string, any>} config
 * @returns {{ ready: Set<string>, missing: string[] }} direct-API providers with credentials, and the configured ones without
 */
function apiStatus(usage, config) {
  const ready = new Set();
  const missing = [];
  const compatBase = hasEnv("COMPAT_BASE_URL") || Boolean(config?.compatBaseUrl && String(config.compatBaseUrl).trim());
  for (const provider of [...Object.keys(API_KEYS), "compat-api"]) {
    const ok = provider === "compat-api" ? compatBase : API_KEYS[provider].some(hasEnv);
    if (ok) ready.add(provider);
    else if (usage.has(provider)) {
      missing.push(provider === "compat-api" ? "compat-api (a base URL)" : `${provider} (${API_KEYS[provider].join(" or ")})`);
    }
  }
  return { ready, missing };
}

/**
 * @param {Map<string, string[]>} usage
 * @param {Record<string, any>} config
 */
function apiKeysCheck(usage, config) {
  const { ready, missing } = apiStatus(usage, config);
  // Names only: a key's value never leaves its variable.
  const present = [...ready].map((p) => (p === "compat-api" ? "a compat-api base URL" : API_KEYS[p].find(hasEnv)));
  if (missing.length > 0) {
    return mk("provider-api-keys", "providers", "Direct API keys", "fail", `Configured but not set: ${missing.join(", ")}.`);
  }
  return mk(
    "provider-api-keys",
    "providers",
    "Direct API keys",
    "ok",
    present.length > 0 ? `Set: ${present.join(", ")}.` : "No direct-API provider is configured and no key is set."
  );
}

/**
 * The at-least-one-lead-and-one-worker summary, from the provider checks.
 *
 * @param {DoctorCheck[]} providerChecks
 * @param {Set<string>} apiReady
 */
function pathsCheck(providerChecks, apiReady) {
  const installed = providerChecks.filter((c) => c.status === "ok").map((c) => c.id.replace(/^provider-/, ""));
  const delegating = installed.filter((p) => DELEGATING_LEADS.has(p));
  const label = "Lead and worker paths";
  const hasWorker = installed.length > 0 || apiReady.size > 0;
  if (!hasWorker) {
    return mk(
      "provider-paths",
      "providers",
      label,
      "fail",
      "No lead and no worker available: install a provider CLI and log in, or set a direct-API key."
    );
  }
  const workers = [...installed, ...apiReady];
  if (delegating.length === 0) {
    // Other leads can answer but cannot call worker tools (see `delegates` in the orchestrator registry).
    return mk(
      "provider-paths",
      "providers",
      label,
      "warn",
      `Workers: ${workers.join(", ")}. No lead that can delegate: install Codex, Claude Code or Antigravity so Kumo can orchestrate.`
    );
  }
  return mk("provider-paths", "providers", label, "ok", `Lead: ${delegating.join(", ")}. Workers: ${workers.join(", ")}.`);
}

// ── bridge ──

/**
 * @param {string|undefined} workspace
 * @param {ConfigState} config
 */
async function bridgeCheck(workspace, config) {
  const label = "MCP bridge";
  // The bridge loads the config itself, and loadConfig moves a corrupt file
  // aside; on a scratch home it runs on defaults and the user's file stays put.
  const scratch = config.state === "invalid" ? fs.mkdtempSync(path.join(os.tmpdir(), "kumo-doctor-")) : undefined;
  let probe;
  try {
    probe = await probeBridge({ workspace: workspace || process.cwd(), timeoutMs: BRIDGE_TIMEOUT_MS, kumoHome: scratch });
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
  if (!probe.ok) return mk("bridge-server", "bridge", label, "fail", probe.details);
  const missing = BUILTIN_ROLES.map((r) => r.tool).filter((tool) => !probe.tools.includes(tool));
  if (missing.length > 0) {
    return mk("bridge-server", "bridge", label, "fail", `Started, but these tools are missing: ${missing.join(", ")}.`);
  }
  return mk("bridge-server", "bridge", label, "ok", `Starts and lists ${probe.tools.length} tools.`);
}

async function ipcCheck() {
  const label = "Engine endpoint";
  const server = new EngineIpcServer({ requests: {} });
  try {
    const endpoint = await server.listen();
    await new Promise((resolve, reject) => {
      const socket = net.connect(endpoint);
      socket.once("connect", () => {
        socket.destroy();
        resolve(undefined);
      });
      socket.once("error", reject);
    });
    return mk("engine-ipc", "bridge", label, "ok", "The endpoint opens, accepts a connection and closes.");
  } catch (err) {
    return mk("engine-ipc", "bridge", label, "fail", `The endpoint could not be opened (${errMessage(err)}). The bridge could not reach a session.`);
  } finally {
    await server.close().catch(() => {});
  }
}

// ── permissions ──

/**
 * The entry ensureAntigravityBridgeConfig writes. Kept in step with it: it
 * decides "already current" by comparing exactly this.
 *
 * @param {string} workspace
 */
function expectedBridgeEntry(workspace) {
  const node = nodeCommand({ persistent: true });
  return { command: node.command, args: [BRIDGE_SERVER_PATH], env: { ...node.env, KUMO_WORKSPACE: workspace } };
}

/**
 * @param {string} workspace
 * @returns {{ state: "ok"|"stale"|"missing"|"no-entry"|"unusable", file: string, error?: string }}
 */
function inspectBridgeConfig(workspace) {
  const file = path.join(workspace, ".agents", "mcp_config.json");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    return errCode(err) === "ENOENT" ? { state: "missing", file } : { state: "unusable", file, error: errCode(err) || errMessage(err) };
  }
  let current;
  try {
    current = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    return { state: "unusable", file, error: "not valid JSON" };
  }
  const servers = current?.mcpServers;
  const plain = (/** @type {unknown} */ v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  if (!plain(current) || (servers !== undefined && !plain(servers))) {
    return { state: "unusable", file, error: "not an MCP config object" };
  }
  const entry = servers?.["kumo-bridge"];
  if (!entry) return { state: "no-entry", file };
  return JSON.stringify(entry) === JSON.stringify(expectedBridgeEntry(workspace)) ? { state: "ok", file } : { state: "stale", file };
}

/**
 * @param {Record<string, any>} config
 * @param {string} workspace
 */
function bridgeConfigCheck(config, workspace) {
  const label = "Antigravity bridge config";
  const make = (/** @type {DoctorCheck["status"]} */ status, /** @type {string} */ detail, /** @type {DoctorCheck["repair"]} */ repair = null) =>
    mk("antigravity-bridge-config", "permissions", label, status, detail, repair);

  // Antigravity reads MCP servers from this file only when it is the lead; as a
  // worker it runs without MCP, so the entry is not needed.
  if (canonicalizeProvider(config.orchestratorProvider) !== "antigravity") {
    return make("ok", "Not needed: Antigravity is not the lead, and workers run without MCP tools.");
  }
  const problem = workspaceProblem(workspace);
  if (problem) return make("warn", problem);
  const found = inspectBridgeConfig(workspace);
  switch (found.state) {
    case "ok":
      return make("ok", `${found.file} lists kumo-bridge.`);
    case "unusable":
      // writeJsonMerged would replace a file it cannot parse; that is never done from here.
      return make("fail", `${found.file} cannot be merged into (${found.error}). Fix or remove it; Doctor will not overwrite it.`);
    case "stale":
      return make("warn", `The kumo-bridge entry in ${found.file} differs from what Kumo would write (the app may have moved).`, bridgeConfigRepair());
    default:
      return make(
        "warn",
        `${found.file} has no kumo-bridge entry, so Antigravity cannot reach the bridge from this workspace. Kumo writes it when a session starts.`,
        bridgeConfigRepair()
      );
  }
}

/**
 * Kumo does not read or write Antigravity's own settings, but guides/providers.md
 * documents a dependency on them: headless agy denies every tool that needs a
 * permission prompt, so a read-only role on Antigravity returns [NO OUTPUT]
 * unless the user allowed the commands it needs under `permissions.allow`.
 *
 * @param {Record<string, any>} config
 */
function antigravityPermissionsCheck(config) {
  const label = "Antigravity permissions";
  const worker = sharedWorker(config);
  const readOnly = listRoles(config)
    .filter((r) => r.access === "read")
    .filter((r) => canonicalizeProvider(resolveRoleTarget(config, r.id, {}, worker).provider) === "antigravity")
    .map((r) => r.id);
  if (readOnly.length === 0) {
    return mk("antigravity-permissions", "permissions", label, "ok", "No read-only role runs on Antigravity, so it needs no allow rules.");
  }
  const file = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
  let allowed = 0;
  let unreadable = "";
  try {
    const allow = JSON.parse(fs.readFileSync(file, "utf-8"))?.permissions?.allow;
    allowed = Array.isArray(allow) ? allow.length : 0;
  } catch (err) {
    if (errCode(err) !== "ENOENT") unreadable = ` It could not be read (${errCode(err) || "not valid JSON"}).`;
  }
  if (allowed > 0) {
    return mk(
      "antigravity-permissions",
      "permissions",
      label,
      "ok",
      `${allowed} allow rule${allowed === 1 ? "" : "s"} in ${file} for the read-only role${readOnly.length === 1 ? "" : "s"} on Antigravity (${readOnly.join(", ")}).`
    );
  }
  // No repair: granting shell permissions in another tool's settings is the user's call.
  return mk(
    "antigravity-permissions",
    "permissions",
    label,
    "warn",
    `Read-only role${readOnly.length === 1 ? "" : "s"} on Antigravity (${readOnly.join(", ")}) may return [NO OUTPUT]: headless agy denies every tool that needs a permission prompt. No permissions.allow rules in ${file}.${unreadable} Allow the read-only commands you want there, or run those roles on Codex or Claude. Kumo never edits that file.`
  );
}

// ── run ──

/**
 * `openWorkspaces` are the folders sessions have open. A `workspace` that is
 * neither one of those nor a registered project is not looked into (its
 * live-log folder would be created, and its files read); one warning says so.
 *
 * @param {{ workspace?: string, openWorkspaces?: string[] }} [opts]
 * @returns {Promise<{ checks: DoctorCheck[], ranAt: number }>}
 */
export async function runDoctor(opts = {}) {
  const asked = cleanWorkspace(opts.workspace);
  const refused = asked !== undefined && !workspaceKnown(asked, opts.openWorkspaces) ? asked : undefined;
  const workspace = refused === undefined ? asked : undefined;
  const state = readConfigState();
  const config = effectiveConfig(state);
  /** @type {Map<string, string[]>} */
  let usage = new Map();
  try {
    usage = providerUsage(config);
  } catch {
    // A hand-edited assignment the engine cannot read; the checks that use it say so.
  }
  const cliLimit = CLI_TIMEOUT_MS + DEADLINE_SLACK_MS;

  const runtime = [
    guarded({ id: "node-version", group: "runtime", label: "Node.js runtime" }, () => nodeCheck()),
    guarded({ id: "git", group: "runtime", label: "Git" }, () => gitCheck(config), cliLimit),
    guarded({ id: "kumo-home", group: "runtime", label: "Kumo data folder" }, () => kumoHomeCheck()),
    guarded({ id: "config-file", group: "runtime", label: "Kumo config" }, () => configCheck(state)),
    ...(workspace ? [guarded({ id: "live-logs", group: "runtime", label: "Worker live logs" }, () => liveLogsCheck(workspace))] : []),
    ...(refused ? [guarded({ id: "workspace-scope", group: "runtime", label: "Workspace" }, () => mk("workspace-scope", "runtime", "Workspace", "warn", unknownWorkspaceDetail(refused)))] : []),
  ];

  const providerJobs = CLI_PROVIDERS.filter((spec) => !spec.onlyWhenUsed || usage.has(spec.provider)).map((spec) =>
    guarded(
      { id: `provider-${spec.provider}`, group: "providers", label: spec.label },
      () => cliCheck(spec, usage.get(spec.provider) || [], state),
      cliLimit
    )
  );
  const providers = Promise.all(providerJobs).then((r) => r.flat());
  const summary = providers.then((checks) =>
    guarded({ id: "provider-paths", group: "providers", label: "Lead and worker paths" }, () => pathsCheck(checks, apiStatus(usage, config).ready))
  );
  const apiKeys = guarded({ id: "provider-api-keys", group: "providers", label: "Direct API keys" }, () => apiKeysCheck(usage, config));

  const bridge = [
    guarded({ id: "bridge-server", group: "bridge", label: "MCP bridge" }, () => bridgeCheck(workspace, state), BRIDGE_TIMEOUT_MS + DEADLINE_SLACK_MS),
    guarded({ id: "engine-ipc", group: "bridge", label: "Engine endpoint" }, () => ipcCheck()),
  ];

  const permissions = [
    ...(workspace
      ? [guarded({ id: "antigravity-bridge-config", group: "permissions", label: "Antigravity bridge config" }, () => bridgeConfigCheck(config, workspace))]
      : []),
    guarded({ id: "antigravity-permissions", group: "permissions", label: "Antigravity permissions" }, () => antigravityPermissionsCheck(config)),
  ];

  const [runtimeChecks, providerChecks, apiChecks, summaryChecks, bridgeChecks, permissionChecks] = await Promise.all([
    Promise.all(runtime),
    providers,
    apiKeys,
    summary,
    Promise.all(bridge),
    Promise.all(permissions),
  ]);
  return {
    checks: [
      ...runtimeChecks.flat(),
      ...providerChecks,
      ...apiChecks,
      ...summaryChecks,
      ...bridgeChecks.flat(),
      ...permissionChecks.flat(),
    ],
    ranAt: Date.now(),
  };
}

// ── repairs ──

/** @typedef {{ ok: boolean, detail: string }} RepairOutcome */

/** @type {Record<string, (ctx: { workspace?: string }) => Promise<RepairOutcome> | RepairOutcome>} */
const REPAIRS = {
  "clear-binary-cache": () => {
    clearBinaryCache();
    clearCliBinaryCache();
    return { ok: true, detail: "Cleared the CLI lookup cache; Kumo will search PATH for each CLI again." };
  },

  "antigravity-bridge-config": ({ workspace }) => {
    if (!workspace) {
      return { ok: false, detail: "Open a workspace first: the bridge entry lives in <workspace>/.agents/mcp_config.json." };
    }
    const problem = workspaceProblem(workspace);
    if (problem) return { ok: false, detail: problem };
    if (process.env.KUMO_NO_SYNC === "1") {
      return { ok: false, detail: "Kumo is set not to write provider config files (KUMO_NO_SYNC=1)." };
    }
    const before = inspectBridgeConfig(workspace);
    if (before.state === "ok") return { ok: true, detail: "The kumo-bridge entry is already current." };
    if (before.state === "unusable") {
      return { ok: false, detail: `${before.file} cannot be merged into (${before.error}). Kumo will not overwrite it; fix or remove it, then retry.` };
    }
    ensureAntigravityBridgeConfig(workspace);
    // ensureAntigravityBridgeConfig reports "false" for both "already current" and "could not write".
    const after = inspectBridgeConfig(workspace);
    return after.state === "ok"
      ? { ok: true, detail: `Wrote the kumo-bridge entry to ${after.file}.` }
      : { ok: false, detail: `Could not write the kumo-bridge entry to ${after.file}.` };
  },

  "prune-live-logs": ({ workspace }) => {
    if (!workspace) return { ok: false, detail: "Open a workspace first: worker logs are kept per workspace." };
    const problem = workspaceProblem(workspace);
    if (problem) return { ok: false, detail: problem };
    const before = scanLiveLogs(workspace);
    pruneLiveLogs(workspace);
    const after = scanLiveLogs(workspace);
    const removed = before.stale - after.stale;
    return after.stale > 0
      ? { ok: false, detail: `Removed ${removed} stale worker log${removed === 1 ? "" : "s"}; ${after.stale} could not be removed.` }
      : { ok: true, detail: `Removed ${removed} stale worker log${removed === 1 ? "" : "s"}.` };
  },
};

/** Repairs that write inside the workspace folder or its Kumo session folder. */
const WORKSPACE_REPAIRS = new Set(["antigravity-bridge-config", "prune-live-logs"]);

/**
 * A repair that changes files for a workspace runs only for a registered
 * project or a folder a session has open (`openWorkspaces`); the renderer can
 * name any folder, and Doctor must not write into one it was never given.
 *
 * @param {string} id
 * @param {{ workspace?: string, openWorkspaces?: string[] }} [opts]
 * @returns {Promise<{ ok: boolean, detail: string, checks: DoctorCheck[] }>}
 */
export async function repairDoctor(id, opts = {}) {
  if (typeof id !== "string" || !Object.hasOwn(REPAIRS, id)) {
    // Nothing ran, so there is no fresh result to return.
    return { ok: false, detail: `No repair '${String(id).slice(0, 60)}'.`, checks: [] };
  }
  const workspace = cleanWorkspace(opts.workspace);
  /** @type {RepairOutcome} */
  let outcome;
  if (workspace && WORKSPACE_REPAIRS.has(id) && !workspaceKnown(workspace, opts.openWorkspaces)) {
    outcome = { ok: false, detail: unknownWorkspaceDetail(workspace) };
  } else {
    try {
      outcome = await REPAIRS[id]({ workspace });
    } catch (err) {
      outcome = { ok: false, detail: `Repair '${id}' failed: ${errMessage(err)}` };
    }
  }
  const { checks } = await runDoctor({ workspace, openWorkspaces: opts.openWorkspaces });
  let detail = outcome.detail;
  if (id === "clear-binary-cache" && checks.some((c) => c.repair?.id === id)) {
    // PATH is fixed when a process starts; a CLI installed since needs a restart.
    detail += " Some CLIs are still not found; one installed after Kumo started may need a Kumo restart to appear on PATH.";
  }
  return { ok: outcome.ok, detail, checks };
}

// ── report ──

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A path as it can appear in text: as given, with forward slashes, and with
 * backslashes doubled the way JSON prints them.
 *
 * @param {string} p
 */
function pathForms(p) {
  return [...new Set([p, p.replaceAll("\\", "/"), p.replaceAll("\\", "\\\\")])];
}

/** Provider tokens by shape, in case a CLI echoes one in its output. */
const TOKEN_SHAPES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

/**
 * Whether a key name holds a secret. The environment-variable shapes of
 * SECRET_ENV_RE, also as they are spelled in JSON and headers: camelCase
 * (`apiKey`, `accessToken`, `clientSecret`) and kebab-case (`x-api-key`), plus
 * cookies.
 *
 * @param {string} name
 */
function isSecretName(name) {
  const spelled = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replaceAll("-", "_");
  return SECRET_ENV_RE.test(name) || SECRET_ENV_RE.test(spelled) || /cookie/i.test(name);
}

/** Account names that say nothing about a person, and read as plain words in a report. */
const GENERIC_USER_NAMES = new Set(["root", "user", "users", "admin", "administrator", "runner", "default", "system", "guest", "kumo", "node"]);

/**
 * The operating-system account names of this process, for scrubbing from text.
 * (The caller drops names too short or too generic to be told from ordinary words.)
 *
 * @returns {string[]}
 */
function osUserNames() {
  /** @type {string[]} */
  const found = [process.env.USERNAME || "", process.env.USER || "", process.env.LOGNAME || ""];
  try {
    found.push(os.userInfo().username);
  } catch {
    /* no account entry for this uid; the environment names above still apply */
  }
  return found;
}

/**
 * Make report text safe to paste into a public issue: secret-looking values,
 * cookies, URL credentials, email addresses, the workspace folder, the home
 * directory (also as it appears in URLs) and the account name are replaced.
 *
 * @param {string} text
 * @param {{ workspace?: string, homes?: string[], users?: string[] }} [opts] - homes, users: test seams, default to this process's home and account names
 * @returns {string}
 */
export function sanitizeForReport(text, { workspace, homes, users } = {}) {
  // Windows paths are case-insensitive; "m" lets the path anchor below match at any line start.
  const flags = process.platform === "win32" ? "gim" : "gm";
  let out = String(text);

  // 1. The value of every credential-shaped environment variable, wherever it shows up.
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV_RE.test(name) && typeof value === "string" && value.trim().length >= 6)
    .map(([, value]) => /** @type {string} */ (value).trim())
    .sort((a, b) => b.length - a.length);
  for (const secret of new Set(secrets)) out = out.replace(new RegExp(escapeRe(secret), "g"), "[redacted]");

  // 2. Cookie and credential headers: the whole value, up to the end of the line.
  out = out.replace(/\b((?:Set-Cookie|Cookie|Proxy-Authorization|Authorization)\s*:\s*)[^\r\n]+/gi, "$1[redacted]");

  // 3. Secrets by shape, and NAME=value / NAME: value / "name": "value" pairs whose name looks like one.
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, "[redacted]");
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_-]*)(\s*[=:]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"']+)/g, (m, name, sep) =>
    isSecretName(name) ? `${name}${sep}[redacted]` : m
  );
  out = out.replace(/"([A-Za-z_][\w-]*)"(\s*:\s*)"(?:[^"\\]|\\.)*"/g, (m, name, colon) =>
    isSecretName(name) ? `"${name}"${colon}"[redacted]"` : m
  );

  // 4. Credentials in a URL (scheme://user:pass@host): keep the host only. Before the email pass, which would keep the user name.
  out = out.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/g, "$1");

  // 5. Email addresses.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]");

  // 6. The workspace, then the home directory (it often contains the workspace),
  // each as written and URL-encoded (C%3A%5CUsers%5Cname).
  /**
   * @param {string} p
   * @param {string} replacement
   */
  const replacePath = (p, replacement) => {
    for (const form of pathForms(p)) {
      out = out.replace(new RegExp(escapeRe(form), flags), replacement);
      out = out.replace(new RegExp(escapeRe(encodeURIComponent(form)), "gi"), replacement);
    }
  };
  if (workspace) replacePath(workspace, "<workspace>");
  const homeDirs = homes ?? [os.homedir(), process.env.USERPROFILE || "", process.env.HOME || ""];
  const unique = [...new Set(homeDirs.filter((h) => h.length >= 4 && path.dirname(h) !== h))].sort((a, b) => b.length - a.length);
  for (const home of unique) replacePath(home, "~");
  // Any other user's home, and the 8.3 short form Windows uses for temp folders (C:\Users\NAME~1).
  // A separator is \, / or its URL-encoded form; the name stops at one.
  out = out.replace(/[A-Za-z](?::|%3A)(?:%5C|%2F|[\\/])+Users(?:%5C|%2F|[\\/])+(?:(?!%5C|%2F)[^\\/\s"'`)<>|])+/gi, "~");
  out = out.replace(/(?<=^|[\s"'(=,?&])(?:%2F|[\\/])+(?:Users|home)(?:%5C|%2F|[\\/])+(?:(?!%5C|%2F)[^\\/\s"'`)<>|])+/gim, "~");

  // 7. The account name on its own ("Welcome alice", "alice-PC"), whole words only.
  const names = [...new Set((users ?? osUserNames()).map((n) => n.trim()))].filter((n) => n.length >= 3 && !GENERIC_USER_NAMES.has(n.toLowerCase()));
  for (const name of names) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, flags), "<user>");
  return out;
}

/** @param {unknown} s */
function idOnly(s) {
  return String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "?").slice(0, 80) || "(default)";
}

/**
 * Provider and model ids only: no keys, prompts or custom-role text.
 *
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
function assignmentLines(config) {
  const lead = activeTargets(config).find((t) => t.role === "orchestrator");
  const worker = sharedWorker(config);
  const lines = [
    `- Lead: ${idOnly(lead?.provider)} / ${idOnly(lead?.model)}`,
    `- Shared worker: ${idOnly(worker.provider)} / ${idOnly(worker.model)}`,
  ];
  for (const role of listRoles(config)) {
    const target = resolveRoleTarget(config, role.id, {}, worker);
    const own = target.assigned ? "" : " (shared worker)";
    lines.push(`- ${idOnly(role.id)}: ${idOnly(canonicalizeProvider(target.provider))} / ${idOnly(target.model)}${own}`);
  }
  return lines;
}

/**
 * @param {{ workspace?: string, openWorkspaces?: string[] }} [opts]
 * @returns {Promise<{ markdown: string }>}
 */
export async function doctorReport(opts = {}) {
  const workspace = cleanWorkspace(opts.workspace);
  const { checks, ranAt } = await runDoctor({ workspace, openWorkspaces: opts.openWorkspaces });
  const config = effectiveConfig(readConfigState());
  /** @type {string[]} */
  let assignments;
  try {
    assignments = assignmentLines(config);
  } catch (err) {
    assignments = [`- The assignments could not be read (${errMessage(err)}).`];
  }
  const electron = process.versions.electron;
  const tally = (/** @type {DoctorCheck["status"]} */ s) => checks.filter((c) => c.status === s).length;

  const lines = [
    "# Kumo diagnostic report",
    "",
    `Generated ${new Date(ranAt).toISOString()}`,
    "",
    "## Environment",
    "",
    `- Kumo: ${VERSION}`,
    `- Platform: ${process.platform} ${process.arch} (${os.release()})`,
    `- Node: ${process.versions.node}`,
    ...(electron ? [`- Electron: ${electron} (running inside the desktop app)`] : []),
    "",
    "## Assignments",
    "",
    ...assignments,
    "",
    `## Checks (${tally("ok")} ok, ${tally("warn")} warn, ${tally("fail")} fail)`,
    "",
    ...checks.map((c) => `- [${c.status.toUpperCase()}] ${c.label} (${c.id}): ${c.detail}`),
    "",
    "_The home directory, email addresses and secret-looking values are redacted from this report. Environment variable values are never included._",
    "",
  ];
  return { markdown: sanitizeForReport(lines.join("\n"), { workspace }) };
}
