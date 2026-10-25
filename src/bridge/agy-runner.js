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
 * agy-runner.js — Subprocess runner for Antigravity / Gemini CLI.
 *
 * Spawns the CLI in non-interactive mode targeting the specified workspace,
 * enforces timeouts, captures output with strict buffer caps, and exposes
 * live quota metrics and model discovery.
 *
 * Authentication: relies on the user's active Google AI Pro subscription login (zero API keys).
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, supportsEffort } from "../config/settings.js";
import { agyEffort } from "../config/models.js";
import { MODEL_CATALOG } from "../config/models.js";
import { formatIsoResetTime } from "../utils/ui.js";
import { loadProjectRegistry, hashWorkspace } from "../data/sessions.js";
import {
  safeSpawn,
  childEnvFor,
  killProcessTree,
  stopProcessTree,
  resolveBinary,
  writeLiveOutput,
} from "../utils/process.js";
import { mustUseStdinPrompt, grantsWrite } from "../providers/workers/cli-runner.js";

/** Default timeout per invocation (5 minutes). */
const DEFAULT_TIMEOUT_MS = clampTimeout(process.env.GEMINI_TIMEOUT_MS || "300000");

/**
 * Clamp a timeout value to [5000, 1800000] ms.
 *
 * @param {*} v
 * @returns {number}
 */
function clampTimeout(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return 300000;
  return Math.min(Math.max(n, 5000), 1800000);
}

/** Maximum output buffer size (1 MB). */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Cached binary path once detected.
 * @type {string | null}
 */
let detectedBin = null;

/**
 * The value `cliBinary` defaulted to before Antigravity became the preferred
 * CLI. Every config written by an older Kumo stores it explicitly, so it cannot
 * be told apart from a deliberate choice; it is therefore treated as "no
 * preference" and only used when `agy` is absent. Users who want the Gemini CLI
 * as a worker select the `gemini-cli` provider instead.
 */
const LEGACY_DEFAULT_CLI_BINARY = "gemini";

/**
 * Resolve a configured binary to an existing absolute path, or null.
 *
 * @param {string} bin
 * @returns {string|null}
 */
function existingBinary(bin) {
  if (!bin) return null;
  // A plain existsSync resolves a bare name against the CWD; resolveBinary
  // searches PATH and returns the bare name on a miss.
  const resolved = resolveBinary(bin);
  return path.isAbsolute(resolved) && fs.existsSync(resolved) ? resolved : null;
}

/**
 * Determine which binary the Antigravity provider invokes:
 * 1. Environment variable AGY_BIN or GEMINI_BIN
 * 2. Cached detected binary
 * 3. A non-default `cliBinary` from ~/.kumo/config.json
 * 4. Local AppData agy.exe installation (standard Antigravity CLI path)
 * 5. `agy` on PATH
 * 6. The legacy default `gemini` on PATH
 * 7. Fallback "agy"
 * @returns {string}
 */
export function getCliBinary() {
  if (process.env.AGY_BIN) return existingBinary(process.env.AGY_BIN) || process.env.AGY_BIN;
  if (process.env.GEMINI_BIN && fs.existsSync(process.env.GEMINI_BIN)) return process.env.GEMINI_BIN;
  if (detectedBin) return detectedBin;

  let configured = null;
  try {
    configured = loadConfig()?.cliBinary || null;
  } catch {
    /* fallback */
  }

  if (configured && configured !== LEGACY_DEFAULT_CLI_BINARY) {
    const found = existingBinary(configured);
    if (found) {
      detectedBin = found;
      return detectedBin;
    }
  }

  // Check local AppData agy installation (standard Antigravity CLI path on Windows)
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const candidate = path.join(localAppData, "agy", "bin", "agy.exe");
    if (fs.existsSync(candidate)) {
      detectedBin = candidate;
      return detectedBin;
    }
  }

  const agy = existingBinary("agy");
  if (agy) {
    detectedBin = agy;
    return detectedBin;
  }

  const legacy = existingBinary(configured || LEGACY_DEFAULT_CLI_BINARY);
  if (legacy) {
    detectedBin = legacy;
    return detectedBin;
  }

  detectedBin = process.env.GEMINI_BIN || "agy";
  return detectedBin;
}

/** Test seam: forget the memoized Antigravity binary. */
export function clearCliBinaryCache() {
  detectedBin = null;
}

/**
 * @typedef {Object} AgyResult
 * @property {boolean} ok       — true if exit code was 0
 * @property {number}  code     — process exit code
 * @property {string}  stdout   — captured stdout (trimmed)
 * @property {string}  stderr   — captured stderr (trimmed)
 * @property {boolean} timedOut — true if killed by timeout
 */

/**
 * Spawn an `agy` or `gemini` subprocess with the given options.
 *
 * @param {Object}   opts
 * @param {string}   opts.prompt         — Task prompt
 * @param {string}   [opts.model]        — Model override
 * @param {string}   [opts.effort]       — Reasoning effort (low|medium|high)
 * @param {string}   [opts.mode]         — "read-only" | "workspace-write"
 * @param {string[]} [opts.files]        — Files to include as context
 * @param {string}   [opts.workspace]    — Target project workspace directory
 * @param {string}   [opts.cwd]          — Alias for workspace
 * @param {number}   [opts.timeoutMs]    — Timeout in ms
 * @param {string}   [opts.systemPrompt] — System-level instructions
 * @returns {Promise<AgyResult>}
 */
export async function runAgy(opts) {
  let config = {};
  try {
    config = loadConfig();
  } catch {
    /* fallback to defaults */
  }

  const {
    prompt,
    // From the bridge, `provider` is set and model/effort are already resolved —
    // possibly to nothing, for a per-call override. Falling back to config here
    // would hand agy the configured worker's model, which may belong to another CLI.
    model = "provider" in opts
      ? opts.model || null
      : opts.model || process.env.GEMINI_MODEL || config.workerModel || null,
    effort = "provider" in opts
      ? opts.effort || null
      : opts.effort || process.env.GEMINI_EFFORT || process.env.WORKER_EFFORT || config.workerEffort || null,
    mode = "read-only",
    files = [],
    workspace = opts.workspace || opts.cwd || process.env.KUMO_WORKSPACE || process.env.ORCHESTRATOR_WORKSPACE || process.cwd(),
    timeoutMs = clampTimeout(process.env.GEMINI_TIMEOUT_MS || String(config.timeoutMs || DEFAULT_TIMEOUT_MS)),
    safetyMode = opts.safetyMode || process.env.KUMO_SAFETY_MODE || config.safetyMode || "autonomous",
    trustWorkspace = opts.trustWorkspace ?? (process.env.KUMO_TRUST_WORKSPACE !== "false" && process.env.KUMO_SKIP_TRUST !== "false" && (config.trustWorkspace !== false)),
    previewDiff = opts.previewDiff || false,
    systemPrompt,
    onChunk = opts.onChunk || null,
    liveLogPath = opts.liveLogPath || null,
  } = opts;

  let bin = getCliBinary();
  // If model is a Claude model, ensure agy is used as gemini CLI only supports Gemini models
  if (model && model.toLowerCase().startsWith("claude-") && path.basename(bin).toLowerCase().startsWith("gemini")) {
    bin = process.env.AGY_BIN || resolveBinary("agy");
  }
  const isGeminiCli = path.basename(bin).toLowerCase().startsWith("gemini");
  const canWrite = grantsWrite({ permission: opts.permission, mode, safetyMode });
  const args = [];

  let compositePrompt = "";
  if (systemPrompt) {
    compositePrompt += `[System Instructions]\n${systemPrompt}\n\n`;
  }
  if (previewDiff) {
    compositePrompt += `[DIFF PREVIEW MODE]\nYou are running in read-only diff preview mode. DO NOT modify any files on disk.\nCarefully analyze the workspace and produce a complete unified git diff (--- a/... +++ b/...) of the exact changes you propose to make, followed by an impact summary.\n\n`;
  }
  if (workspace) {
    compositePrompt += `[Target Workspace]\n${workspace}\n`;
    try {
      const registry = loadProjectRegistry?.() || {};
      const hash = hashWorkspace(path.resolve(workspace));
      const extras = registry[hash]?.accessibleFolders || [];
      if (extras.length > 0) {
        compositePrompt += `[Authorized Accessible Folders]\n${extras.map((f) => `- ${f}`).join("\n")}\nYou have explicit permission to access files in these folders in addition to the workspace.\n`;
      }
    } catch {
      /* ignore */
    }
    compositePrompt += `Stay strictly inside this workspace directory and authorized accessible folders. Do not explore unauthorized parent directories or search external drives.\n\n`;
  }
  if (files && files.length > 0) {
    compositePrompt += `[Relevant Files]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }
  if (!canWrite) {
    // Headless agy auto-denies any tool that needs a permission prompt —
    // shell commands included — and then exits 0 with no output. Steering the
    // model to its built-in file tools keeps a read-only task answerable.
    compositePrompt +=
      `[Permissions]\nThis task is read-only. Do not create, modify, or delete files. ` +
      `Shell commands and MCP tools are not available; use only your built-in file listing, reading, and search tools.\n\n`;
  }
  compositePrompt += `[Task]\n${prompt}`;

  // A composite prompt cannot survive a Windows .cmd shim: cmd.exe treats the
  // embedded newlines as command separators and caps the line at ~8191 chars.
  const promptViaStdin = mustUseStdinPrompt(bin, compositePrompt);

  if (isGeminiCli) {
    args.push("-p");
    if (!promptViaStdin) args.push(compositePrompt);
    if (model) {
      args.push("-m", model);
    }
    if (trustWorkspace) {
      args.push("--skip-trust");
    }
    if (canWrite) {
      args.push("-y");
      args.push("--approval-mode", "yolo");
    }
  } else {
    // agy CLI flags
    args.push("-p");
    if (!promptViaStdin) args.push(compositePrompt);
    if (model) {
      args.push("--model", model);
    }
    if (effort && supportsEffort(model)) {
      args.push("--effort", agyEffort(effort));
    }
    if (canWrite) {
      args.push("--dangerously-skip-permissions");
      args.push("--mode", "accept-edits");
    }
  }

  // This child runs with permission-bypass flags, so it must not receive every
  // credential in the operator's shell. Antigravity authenticates from its own
  // on-disk session, not from environment keys.
  const childEnv = childEnvFor(
    "antigravity",
    trustWorkspace ? { GEMINI_CLI_TRUST_WORKSPACE: "true" } : {}
  );

  const isTransientSocketError = (str) =>
    /wsarecv|connection was forcibly closed|connection reset|ECONNRESET|streamGenerateContent/i.test(str || "");

  const executeOnce = () =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const proc = safeSpawn(bin, args, {
        cwd: workspace,
        stdio: [promptViaStdin ? "pipe" : "ignore", "pipe", "pipe"],
        env: childEnv,
      });

      if (promptViaStdin && proc.stdin) {
        proc.stdin.on("error", () => {
          /* the child may exit before draining stdin */
        });
        proc.stdin.end(compositePrompt, "utf-8");
      }

      // Precise output buffering with hard cap
      proc.stdout?.on("data", (chunk) => {
        if (onChunk) {
          try { onChunk("stdout", chunk); } catch {}
        }
        writeLiveOutput(liveLogPath, chunk);
        if (stdout.length < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stdout.length;
          const str = chunk.toString();
          stdout += str.length <= remaining ? str : str.slice(0, remaining);
        }
      });

      proc.stderr?.on("data", (chunk) => {
        if (onChunk) {
          try { onChunk("stderr", chunk); } catch {}
        }
        writeLiveOutput(liveLogPath, chunk);
        if (stderr.length < MAX_OUTPUT_BYTES) {
          const remaining = MAX_OUTPUT_BYTES - stderr.length;
          const str = chunk.toString();
          stderr += str.length <= remaining ? str : str.slice(0, remaining);
        }
      });

      let escalation = null;
      const timer = setTimeout(() => {
        if (!settled) {
          timedOut = true;
          // Tree kill on Windows, where SIGTERM would stop only the shim; see
          // runCliWorker for why a delayed escalation alone is not enough.
          stopProcessTree(proc);
          escalation = setTimeout(() => killProcessTree(proc), 5000);
          escalation.unref?.();
        }
      }, timeoutMs);

      proc.on("close", (code) => {
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalation);

        resolve({
          ok: code === 0,
          code: code ?? 1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
        });
      });

      proc.on("error", (err) => {
        settled = true;
        clearTimeout(timer);
        clearTimeout(escalation);

        resolve({
          ok: false,
          code: 1,
          stdout: stdout.trim(),
          stderr: (stderr + `\nFailed to spawn CLI '${bin}': ${err.message}. Ensure '${bin}' is installed or set AGY_BIN.`).trim(),
          timedOut: false,
        });
      });
    });

  let attempts = 0;
  // A write task may already have edited files when the connection dropped;
  // running it again would apply those edits a second time.
  const maxAttempts = canWrite ? 1 : 2;
  while (attempts < maxAttempts) {
    attempts++;
    const res = await executeOnce();
    if (res.ok || !isTransientSocketError(res.stderr) || attempts >= maxAttempts) {
      return res;
    }
    const retryMarker = "\n[retrying worker call...]\n";
    if (onChunk) {
      try { onChunk("stdout", Buffer.from(retryMarker)); } catch {}
    }
    writeLiveOutput(liveLogPath, retryMarker);
    // Wait briefly before retrying transient connection reset
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Whether a model id names Gemini 4 Argon, which has its own Antigravity limit.
 *
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isArgonModel(model) {
  return /\bargon\b/i.test(String(model || "").replace(/[-_.]/g, " "));
}

/** @param {{ group: string, metric: string }} item */
function isArgonUsageRow(item) {
  return /\bargon\b/i.test(item.group) || /\bargon\b/i.test(item.metric);
}

/**
 * Parse `agy -p /usage` output. Each line is tab-separated:
 * `<group>\t<metric>\t<percent>%\t<reset ISO>`, and every percentage is what
 * is *remaining* (agy 1.2: "Weekly Limit Remaining 99%").
 *
 * Besides the family-wide rows ("Gemini Models", "Claude and GPT models"),
 * agy lists per-model limits ("Gemini 4 Argon … Weekly Limit"). Those used to
 * overwrite the family figure because they come later; a family row now wins
 * and a per-model row only fills a slot no family row provided.
 *
 * Gemini 4 Argon rows are also kept apart in `geminiArgonWeekly*` /
 * `geminiArgon5Hour*`, because Argon draws on a limit of its own.
 *
 * @param {string} stdout
 * @returns {Object|null} null when no line could be parsed
 */
export function parseAgyUsage(stdout) {
  const usage = {
    geminiWeeklyPercent: null,
    geminiWeeklyResetFormatted: null,
    geminiWeeklyResetIso: null,
    gemini5HourPercent: null,
    gemini5HourResetFormatted: null,
    gemini5HourResetIso: null,
    geminiArgonWeeklyPercent: null,
    geminiArgonWeeklyResetFormatted: null,
    geminiArgonWeeklyResetIso: null,
    geminiArgon5HourPercent: null,
    geminiArgon5HourResetFormatted: null,
    geminiArgon5HourResetIso: null,
    claudeGptWeeklyPercent: null,
    claudeGptWeeklyResetFormatted: null,
    claudeGptWeeklyResetIso: null,
    claudeGpt5HourPercent: null,
    claudeGpt5HourResetFormatted: null,
    claudeGpt5HourResetIso: null,
    rawItems: [],
  };

  for (const line of String(stdout || "").trim().split(/\r?\n/)) {
    const parts = line.split("\t").map((s) => s.trim());
    if (parts.length < 3) continue;
    const percent = parseInt(parts[2].replace("%", ""), 10);
    if (!Number.isFinite(percent)) continue;
    usage.rawItems.push({ group: parts[0], metric: parts[1], percent, resetIso: parts[3] || null });
  }
  if (usage.rawItems.length === 0) return null;

  const isFamilyRow = (item) => /\bmodels\b/i.test(item.group);
  const ordered = [...usage.rawItems.filter(isFamilyRow), ...usage.rawItems.filter((i) => !isFamilyRow(i))];
  const set = (prefix, item) => {
    if (usage[`${prefix}Percent`] !== null) return;
    usage[`${prefix}Percent`] = item.percent;
    usage[`${prefix}ResetFormatted`] = formatIsoResetTime(item.resetIso);
    usage[`${prefix}ResetIso`] = item.resetIso;
  };

  for (const item of ordered) {
    const group = item.group.toLowerCase();
    const metric = item.metric.toLowerCase();
    const weekly = metric.includes("weekly");
    const fiveHour = /five hour|5-hour|5 hour/.test(metric);
    // Gemini 4 Argon has a limit of its own; it also stands in for the
    // Gemini family figure below when agy reports no family row.
    if (isArgonUsageRow(item)) {
      if (weekly) set("geminiArgonWeekly", item);
      else if (fiveHour) set("geminiArgon5Hour", item);
    }
    if (group.includes("gemini")) {
      if (weekly) set("geminiWeekly", item);
      else if (fiveHour) set("gemini5Hour", item);
    } else if (group.includes("claude") || group.includes("gpt")) {
      if (weekly) set("claudeGptWeekly", item);
      else set("claudeGpt5Hour", item);
    }
  }
  return usage;
}

/** The `agy -p /usage` run in progress, shared by everyone who asks meanwhile. */
/** @type {Promise<Object | null> | null} */
let usageRun = null;

/**
 * Query live Antigravity / Gemini usage limits via `agy -p /usage`. Callers
 * that ask while a run is going get its answer: with Antigravity as the lead,
 * the lead's limits and the usage poll ask at the same moment.
 *
 * @returns {Promise<Object | null>}
 */
export function getAgyUsage() {
  if (!usageRun) {
    usageRun = readAgyUsage().finally(() => {
      usageRun = null;
    });
  }
  return usageRun;
}

/** @returns {Promise<Object | null>} */
async function readAgyUsage() {
  const bin = getCliBinary();
  if (!existingBinary(bin) && !fs.existsSync(bin)) return null;

  return new Promise((resolve) => {
    let stdout = "";
    const proc = safeSpawn(bin, ["-p", "/usage"], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve(null);
    }, 6000);

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        return resolve(null);
      }
      resolve(parseAgyUsage(stdout));
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Health check — is the Antigravity CLI installed and logged in?
 *
 * `agy -p /usage` answers from the account without running a model, so the
 * check costs no quota; it used to send a real prompt ("Reply with PONG"),
 * which spent quota on every `kumo status`. Usage data only comes back for a
 * logged-in account, so getting it is the authentication signal.
 *
 * @param {{ usage?: Object|null }} [opts] - an already fetched usage result, to skip a second spawn
 * @returns {Promise<{installed: boolean, authenticated: boolean, binary: string, usage: Object|null, error?: string}>}
 */
export async function checkAgyHealth(opts = {}) {
  const bin = getCliBinary();
  const resolved = resolveBinary(bin);
  if (!path.isAbsolute(resolved) || !fs.existsSync(resolved)) {
    return { installed: false, authenticated: false, binary: bin, usage: null, error: `'${bin}' was not found` };
  }
  const usage = opts.usage !== undefined ? opts.usage : await getAgyUsage();
  return {
    installed: true,
    authenticated: Boolean(usage),
    binary: resolved,
    usage: usage || null,
    error: usage ? undefined : "the usage query returned nothing; run agy once to log in",
  };
}

/** The effort variants `agy models` lists, lowest first. */
const AGY_EFFORT_ORDER = ["low", "medium", "high"];

/** Default fallback worker models */
export const DEFAULT_WORKER_MODELS = MODEL_CATALOG.antigravity.map(({ id, name }) => ({ id, name }));

/**
 * Discover available worker models via `agy models`. agy lists a model once
 * per effort it takes (`gemini-3.8-flash-low`, `-medium`, `-high`); each comes
 * back once, with those efforts in `efforts` (empty when it has no variants).
 * @returns {Promise<Array<{id: string, name: string, efforts?: string[]}>>}
 */
export async function getAgyModels() {
  const bin = getCliBinary();

  return new Promise((resolve) => {
    let stdout = "";
    const proc = safeSpawn(bin, ["models"], {
      stdio: ["ignore", "pipe", "ignore"],
    });

    const timer = setTimeout(() => {
      killProcessTree(proc);
      resolve(DEFAULT_WORKER_MODELS);
    }, 4000);

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        return resolve(DEFAULT_WORKER_MODELS);
      }

      const lines = stdout.trim().split("\n");
      /** @type {Array<{id: string, name: string, efforts: string[]}>} */
      const models = [];
      /** @type {Map<string, {id: string, name: string, efforts: string[]}>} */
      const seen = new Map();

      for (const line of lines) {
        const parts = line.split("\t").map((s) => s.trim());
        const id = parts[0];
        const displayName = parts[1] || id;

        if (!id || id.toLowerCase().includes("fetching") || id.toLowerCase().startsWith("usage")) {
          continue;
        }

        // Clean base model identifier
        const variant = /-(high|medium|low)$/.exec(id)?.[1] ?? null;
        const baseId = variant ? id.slice(0, -(variant.length + 1)) : id;

        let model = seen.get(baseId);
        if (!model) {
          model = { id: baseId, name: displayName.replace(/\s*\((High|Medium|Low)\)/i, ""), efforts: [] };
          seen.set(baseId, model);
          models.push(model);
        }
        if (variant && !model.efforts.includes(variant)) model.efforts.push(variant);
      }
      for (const model of models) model.efforts.sort((a, b) => AGY_EFFORT_ORDER.indexOf(a) - AGY_EFFORT_ORDER.indexOf(b));

      resolve(models.length > 0 ? models : DEFAULT_WORKER_MODELS);
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(DEFAULT_WORKER_MODELS);
    });
  });
}
