/**
 * agy-runner.js — Manages Antigravity / Gemini CLI subprocess lifecycle.
 *
 * Spawns `agy` (or `gemini` CLI) in non-interactive mode, captures output,
 * enforces timeouts, and returns structured results to the bridge server.
 *
 * Authentication: relies on the user's active Google AI Pro subscription login.
 * No API keys are read or stored.
 */

import { spawn } from "node:child_process";
/** Default timeout per invocation (5 minutes). */
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "300000", 10);

/** Maximum output buffer size (1 MB). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Cached binary name once detected.
 * @type {string | null}
 */
let detectedBin = null;

import { execSync } from "node:child_process";

export function getCliBinary() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  if (process.env.GEMINI_BIN) return process.env.GEMINI_BIN;
  if (detectedBin) return detectedBin;

  // Check if agy is available in PATH
  try {
    const cmd = process.platform === "win32" ? "where.exe agy" : "which agy";
    execSync(cmd, { stdio: "ignore" });
    detectedBin = "agy";
    return detectedBin;
  } catch {
    /* agy not found */
  }

  // Fallback to gemini CLI
  try {
    const cmd = process.platform === "win32" ? "where.exe gemini" : "which gemini";
    execSync(cmd, { stdio: "ignore" });
    detectedBin = "gemini";
    return detectedBin;
  } catch {
    /* neither found */
  }

  detectedBin = "gemini";
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
 * Spawn an `agy` or `gemini` process with the given arguments and return its output.
 *
 * @param {Object}   opts
 * @param {string}   opts.prompt       — The task prompt to send to Gemini
 * @param {string}   [opts.model]      — Model override (default: gemini-3.8-flash)
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
    mode = "read-only",
    files = [],
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    systemPrompt,
  } = opts;

  const bin = getCliBinary();
  const isGeminiCli = bin.toLowerCase().includes("gemini");
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

  if (isGeminiCli) {
    // Flag format for Gemini CLI
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
    // Flag format for Antigravity CLI (agy)
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

    const isWin = process.platform === "win32";
    const spawnBin = isWin ? "cmd.exe" : bin;
    const spawnArgs = isWin ? ["/d", "/s", "/c", bin, ...args] : args;

    const proc = spawn(spawnBin, spawnArgs, {
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
        stderr: `Failed to spawn CLI binary '${bin}': ${err.message}. Ensure '${bin}' is installed and in PATH, or set AGY_BIN.`,
        timedOut: false,
      });
    });
  });
}

/**
 * Health check — verify CLI is installed and can be invoked.
 * @returns {Promise<{installed: boolean, authenticated: boolean, binary: string, error?: string}>}
 */
export async function checkAgyHealth() {
  const bin = getCliBinary();
  try {
    const result = await runAgy({
      prompt: "Reply with 'PONG' and nothing else.",
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
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
