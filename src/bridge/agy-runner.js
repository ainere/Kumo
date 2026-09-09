/**
 * agy-runner.js — Subprocess runner for Antigravity / Gemini CLI.
 *
 * Spawns the CLI in non-interactive mode targeting the specified workspace,
 * enforces timeouts, captures output, and returns structured results.
 *
 * Uses the user's active Google AI Pro subscription login (zero API keys).
 */

import { spawn } from "node:child_process";
import { loadConfig } from "../config/settings.js";

/** Maximum output buffer size (1 MB). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Determine the CLI binary to use:
 * 1. Environment variable AGY_BIN or GEMINI_BIN
 * 2. Stored user config in ~/.orchestrator/config.json
 * 3. Default "agy"
 * @returns {string}
 */
export function getCliBinary() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  if (process.env.GEMINI_BIN) return process.env.GEMINI_BIN;

  try {
    const config = loadConfig();
    if (config.cliBinary) return config.cliBinary;
  } catch {
    /* fallback to default */
  }

  return "agy";
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
 * @param {string}   [opts.mode]         — "read-only" | "workspace-write"
 * @param {string[]} [opts.files]        — Files to include as context
 * @param {string}   [opts.workspace]    — Target project workspace directory
 * @param {number}   [opts.timeoutMs]    — Timeout in ms
 * @param {string}   [opts.systemPrompt] — System-level instructions
 * @returns {Promise<AgyResult>}
 */
export async function runAgy(opts) {
  const config = loadConfig();
  const {
    prompt,
    model = process.env.GEMINI_MODEL || config.workerModel || "gemini-3.8-flash",
    mode = "read-only",
    files = [],
    workspace = process.env.ORCHESTRATOR_WORKSPACE || process.cwd(),
    timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || String(config.timeoutMs || 300000), 10),
    systemPrompt,
  } = opts;

  const bin = getCliBinary();
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
    args.push("--non-interactive");
    args.push("--model", model);
    if (mode === "read-only") {
      args.push("--sandbox", "read-only");
    } else if (mode === "workspace-write") {
      args.push("--sandbox", "workspace-write");
    }

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    for (const f of files) {
      args.push("--file", f);
    }

    args.push("--prompt", prompt);
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
      shell: process.platform === "win32",
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
        stderr: `Failed to spawn CLI '${bin}': ${err.message}. Ensure '${bin}' is installed and in PATH, or configure cliBinary.`,
        timedOut: false,
      });
    });
  });
}
