/**
 * agy-runner.js — Manages Antigravity / Gemini CLI subprocess lifecycle.
 *
 * Spawns `agy` CLI in non-interactive print mode, captures output,
 * enforces timeouts, and exposes live quota metrics to Kumo.
 *
 * Authentication: relies on the user's active Google AI Pro subscription login.
 * No API keys are read or stored.
 */

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { formatIsoResetTime } from "../src/utils/ui.js";

/** Default timeout per invocation (5 minutes). */
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "300000", 10);

/** Maximum output buffer size (1 MB). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Cached binary path once detected.
 * @type {string | null}
 */
let detectedBin = null;

/**
 * Determine which binary to invoke. Checks local AppData agy.exe first,
 * then PATH, then environment overrides.
 * @returns {string}
 */
export function getCliBinary() {
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN;
  if (detectedBin) return detectedBin;

  // 1. Check local AppData agy installation (standard Antigravity CLI path)
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
    const candidate = path.join(localAppData, "agy", "bin", "agy.exe");
    if (fs.existsSync(candidate)) {
      detectedBin = candidate;
      return detectedBin;
    }
  }

  // 2. Check if agy is in system PATH
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

  // 3. Fallback to 'agy' command or GEMINI_BIN
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
 * Spawn an `agy` process with the given arguments and return its output.
 *
 * @param {Object}   opts
 * @param {string}   opts.prompt       — The task prompt to send to Gemini
 * @param {string}   [opts.model]      — Model override (default: gemini-3.8-flash)
 * @param {string}   [opts.effort]     — Reasoning effort (low|medium|high, default: low)
 * @param {string}   [opts.mode]       — Sandbox mode: "read-only" | "workspace-write"
 * @param {string[]} [opts.files]      — Files to include as context
 * @param {string}   [opts.cwd]        — Working directory (defaults to process.cwd())
 * @param {number}   [opts.timeoutMs]  — Timeout in milliseconds
 * @param {string}   [opts.systemPrompt] — Optional system-level instruction
 * @returns {Promise<AgyResult>}
 */
export async function runAgy(opts) {
  const {
    prompt,
    model = process.env.GEMINI_MODEL || "gemini-3.8-flash",
    effort = "low",
    mode = "read-only",
    files = [],
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    systemPrompt,
  } = opts;

  const bin = getCliBinary();
  const args = [];

  // Compose full prompt if system prompt or files are provided
  let compositePrompt = "";
  if (systemPrompt) {
    compositePrompt += `[System Instructions]\n${systemPrompt}\n\n`;
  }
  if (files && files.length > 0) {
    compositePrompt += `[Relevant Files]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }
  compositePrompt += `[Task]\n${prompt}`;

  // agy CLI native flags
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
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
      shell: false,
    });

    proc.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString();
      }
    });

    proc.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString();
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
        stderr: `Failed to spawn Antigravity CLI '${bin}': ${err.message}. Ensure Antigravity is installed or set AGY_BIN.`,
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
            } else if (metric.toLowerCase().includes("five hour") || metric.toLowerCase().includes("5-hour") || metric.toLowerCase().includes("5 hour")) {
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

