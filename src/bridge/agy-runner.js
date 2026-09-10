/**
 * agy-runner.js — Subprocess runner for Antigravity / Gemini CLI.
 *
 * Spawns the CLI in non-interactive mode targeting the specified workspace,
 * enforces timeouts, captures output with strict buffer caps, and exposes
 * live quota metrics and model discovery.
 *
 * Authentication: relies on the user's active Google AI Pro subscription login (zero API keys).
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/settings.js";
import { formatIsoResetTime } from "../utils/ui.js";

/** Default timeout per invocation (5 minutes). */
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "300000", 10);

/** Maximum output buffer size (1 MB). */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Cached binary path once detected.
 * @type {string | null}
 */
let detectedBin = null;

/**
 * Determine which binary to invoke:
 * 1. Environment variable AGY_BIN or GEMINI_BIN
 * 2. Cached detected binary
 * 3. Stored user config in ~/.kumo/config.json
 * 4. Local AppData agy.exe installation (standard Antigravity CLI path)
 * 5. System PATH via where.exe / which
 * 6. Fallback "agy"
 * @returns {string}
 */
export function getCliBinary() {
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN;
  if (process.env.GEMINI_BIN && fs.existsSync(process.env.GEMINI_BIN)) return process.env.GEMINI_BIN;
  if (detectedBin) return detectedBin;

  try {
    const config = loadConfig();
    if (config?.cliBinary && fs.existsSync(config.cliBinary)) {
      detectedBin = config.cliBinary;
      return detectedBin;
    }
  } catch {
    /* fallback */
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

  // Check if agy is in system PATH
  try {
    const cmd = process.platform === "win32" ? "where.exe agy" : "which agy";
    const found = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" }).trim().split("\r\n")[0];
    if (found && fs.existsSync(found)) {
      detectedBin = found;
      return detectedBin;
    }
  } catch {
    /* not in PATH */
  }

  detectedBin = process.env.GEMINI_BIN || "agy";
  return detectedBin;
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
    model = process.env.GEMINI_MODEL || config.workerModel || "gemini-3.8-flash",
    effort = process.env.GEMINI_EFFORT || process.env.WORKER_EFFORT || config.workerEffort || "low",
    mode = "read-only",
    files = [],
    workspace = opts.cwd || process.env.KUMO_WORKSPACE || process.env.ORCHESTRATOR_WORKSPACE || process.cwd(),
    timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || String(config.timeoutMs || DEFAULT_TIMEOUT_MS), 10),
    systemPrompt,
  } = opts;

  let bin = getCliBinary();
  // If model is a Claude model, ensure agy is used as gemini CLI only supports Gemini models
  if (model && model.toLowerCase().startsWith("claude-") && bin.toLowerCase().includes("gemini")) {
    bin = process.env.AGY_BIN || "agy";
  }
  const isGeminiCli = bin.toLowerCase().includes("gemini");
  const args = [];

  let compositePrompt = "";
  if (systemPrompt) {
    compositePrompt += `[System Instructions]\n${systemPrompt}\n\n`;
  }
  if (files && files.length > 0) {
    compositePrompt += `[Relevant Files]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }
  compositePrompt += `[Task]\n${prompt}`;

  if (isGeminiCli) {
    args.push("-p", compositePrompt);
    args.push("-m", model);
    args.push("--skip-trust");
    if (mode === "workspace-write") {
      args.push("-y");
      args.push("--approval-mode", "yolo");
    } else {
      args.push("--approval-mode", "plan");
    }
  } else {
    // agy CLI flags
    args.push("-p", compositePrompt);
    args.push("--model", model);
    if (effort) {
      args.push("--effort", effort);
    }
    args.push("--dangerously-skip-permissions");

    if (mode === "workspace-write") {
      args.push("--mode", "accept-edits");
    } else {
      args.push("--mode", "plan");
    }
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const childEnv = {
      ...process.env,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };

    const proc = spawn(bin, args, {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      shell: false,
    });

    // Precise output buffering with hard cap
    proc.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stdout.length;
        const str = chunk.toString();
        stdout += str.length <= remaining ? str : str.slice(0, remaining);
      }
    });

    proc.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        const remaining = MAX_OUTPUT_BYTES - stderr.length;
        const str = chunk.toString();
        stderr += str.length <= remaining ? str : str.slice(0, remaining);
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 5000);
      }
    }, timeoutMs);

    proc.on("close", (code) => {
      settled = true;
      clearTimeout(timer);

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

      resolve({
        ok: false,
        code: 1,
        stdout: "",
        stderr: `Failed to spawn CLI '${bin}': ${err.message}. Ensure '${bin}' is installed or set AGY_BIN.`,
        timedOut: false,
      });
    });
  });
}

/**
 * Query live Antigravity / Gemini usage limits via `agy -p /usage`.
 *
 * @returns {Promise<Object | null>}
 */
export async function getAgyUsage() {
  const bin = getCliBinary();

  return new Promise((resolve) => {
    let stdout = "";
    const proc = spawn(bin, ["-p", "/usage"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
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

      const lines = stdout.trim().split("\n");
      const usage = {
        geminiWeeklyPercent: null,
        geminiWeeklyResetFormatted: null,
        geminiWeeklyResetIso: null,
        gemini5HourPercent: null,
        gemini5HourResetFormatted: null,
        gemini5HourResetIso: null,
        claudeGptWeeklyPercent: null,
        claudeGptWeeklyResetFormatted: null,
        claudeGptWeeklyResetIso: null,
        claudeGpt5HourPercent: null,
        claudeGpt5HourResetFormatted: null,
        claudeGpt5HourResetIso: null,
        rawItems: [],
      };

      for (const line of lines) {
        const parts = line.split("\t").map((s) => s.trim());
        if (parts.length >= 3) {
          const group = parts[0];
          const metric = parts[1];
          const percentStr = parts[2].replace("%", "");
          const percent = parseInt(percentStr, 10);
          const resetIso = parts[3] || null;

          usage.rawItems.push({ group, metric, percent, resetIso });

          if (group.toLowerCase().includes("gemini")) {
            if (metric.toLowerCase().includes("weekly")) {
              usage.geminiWeeklyPercent = percent;
              usage.geminiWeeklyResetFormatted = formatIsoResetTime(resetIso);
              usage.geminiWeeklyResetIso = resetIso;
            } else if (
              metric.toLowerCase().includes("five hour") ||
              metric.toLowerCase().includes("5-hour") ||
              metric.toLowerCase().includes("5 hour")
            ) {
              usage.gemini5HourPercent = percent;
              usage.gemini5HourResetFormatted = formatIsoResetTime(resetIso);
              usage.gemini5HourResetIso = resetIso;
            }
          } else if (group.toLowerCase().includes("claude") || group.toLowerCase().includes("gpt")) {
            if (metric.toLowerCase().includes("weekly")) {
              usage.claudeGptWeeklyPercent = percent;
              usage.claudeGptWeeklyResetFormatted = formatIsoResetTime(resetIso);
              usage.claudeGptWeeklyResetIso = resetIso;
            } else {
              usage.claudeGpt5HourPercent = percent;
              usage.claudeGpt5HourResetFormatted = formatIsoResetTime(resetIso);
              usage.claudeGpt5HourResetIso = resetIso;
            }
          }
        }
      }

      resolve(usage);
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Health check — verify Antigravity CLI is installed and can be invoked.
 * @returns {Promise<{installed: boolean, authenticated: boolean, binary: string, error?: string}>}
 */
export async function checkAgyHealth() {
  const bin = getCliBinary();
  try {
    const result = await runAgy({
      prompt: "Reply with 'PONG' and nothing else.",
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      effort: "low",
      mode: "read-only",
      timeoutMs: 15_000,
    });

    return {
      installed: true,
      authenticated: result.ok,
      binary: bin,
      error: result.ok ? undefined : (result.stderr || result.stdout),
    };
  } catch (err) {
    return {
      installed: false,
      authenticated: false,
      binary: bin,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Default fallback worker models */
export const DEFAULT_WORKER_MODELS = [
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
  { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
  { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
];

/**
 * Discover available worker models via `agy models`.
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getAgyModels() {
  const bin = getCliBinary();

  return new Promise((resolve) => {
    let stdout = "";
    const proc = spawn(bin, ["models"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
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
      const models = [];
      const seen = new Set();

      for (const line of lines) {
        const parts = line.split("\t").map((s) => s.trim());
        const id = parts[0];
        const displayName = parts[1] || id;

        if (!id || id.toLowerCase().includes("fetching") || id.toLowerCase().startsWith("usage")) {
          continue;
        }

        // Clean base model identifier
        let baseId = id;
        if (id.endsWith("-high") || id.endsWith("-medium") || id.endsWith("-low")) {
          baseId = id.replace(/-(high|medium|low)$/, "");
        }

        if (!seen.has(baseId)) {
          seen.add(baseId);
          models.push({
            id: baseId,
            name: displayName.replace(/\s*\((High|Medium|Low)\)/i, ""),
          });
        }
      }

      resolve(models.length > 0 ? models : DEFAULT_WORKER_MODELS);
    });

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(DEFAULT_WORKER_MODELS);
    });
  });
}
