/**
 * codex.js — OpenAI Codex worker provider adapter.
 * Runs non-interactive worker tasks using `codex exec`.
 */

import { findCodexBinary } from "../orchestrators/codex.js";
import { safeSpawn } from "../../utils/process.js";

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_TIMEOUT_MS = 300000;

export const PROVIDER_INFO = {
  id: "codex",
  name: "OpenAI Codex Worker",
};

/**
 * Execute a bounded worker task using Codex CLI.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - Task instructions
 * @param {string} [opts.mode] - 'read-only' or 'workspace-write'
 * @param {string[]} [opts.files] - Optional list of relevant files
 * @param {string} [opts.workspace] - Target directory
 * @param {string} [opts.model] - Specific model ID override
 * @param {string} [opts.effort] - Specific reasoning effort override
 * @param {string} [opts.systemPrompt] - System prompt instructions
 * @param {boolean} [opts.previewDiff] - Whether to enforce read-only diff generation
 * @param {number} [opts.timeoutMs] - Execution timeout
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function executeTask(opts) {
  const {
    prompt,
    mode = "read-only",
    files = [],
    workspace = process.cwd(),
    model,
    effort,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const bin = findCodexBinary();
  const args = ["exec", "--ephemeral"];

  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }

  let compositePrompt = "";
  if (systemPrompt) {
    compositePrompt += `[System Instructions]\n${systemPrompt}\n\n`;
  }
  if (previewDiff) {
    compositePrompt += `[DIFF PREVIEW MODE]\nYou are running in read-only diff preview mode. DO NOT modify any files on disk.\nCarefully analyze the workspace and produce a complete unified git diff (--- a/... +++ b/...) of the exact changes you propose to make, followed by an impact summary.\n\n`;
  }
  if (files && files.length > 0) {
    compositePrompt += `[Relevant Files]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }
  compositePrompt += `[Task]\n${prompt}`;
  args.push(compositePrompt);

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const proc = safeSpawn(bin, args, {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

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
        stderr: `Failed to spawn Codex worker '${bin}': ${err.message}`,
        timedOut: false,
      });
    });
  });
}
