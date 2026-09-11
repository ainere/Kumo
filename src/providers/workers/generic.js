/**
 * generic.js — Generic worker provider adapter for arbitrary external CLI tools.
 */

import { safeSpawn } from "../../utils/process.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300000;

export function createWorker(commandName) {
  return {
    PROVIDER_INFO: {
      id: commandName,
      name: `${commandName} Worker`,
    },
    async executeTask(opts) {
      return executeGenericTask({ ...opts, command: commandName });
    },
  };
}

export async function executeGenericTask(opts) {
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
    command = "agent",
    bin = command,
  } = opts;

  const args = [];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }

  let compositePrompt = "";
  if (systemPrompt) {
    compositePrompt += `[System Instructions]\n${systemPrompt}\n\n`;
  }
  if (previewDiff) {
    compositePrompt += `[DIFF PREVIEW MODE]\nProduce a complete unified git diff without modifying files on disk.\n\n`;
  }
  if (files && files.length > 0) {
    compositePrompt += `[Relevant Files]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }
  compositePrompt += `[Task]\n${prompt}`;

  args.push("-p", compositePrompt);

  if (mode === "workspace-write") {
    args.push("--dangerously-skip-permissions");
  }

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
        stderr: `Failed to spawn worker '${bin}': ${err.message}`,
        timedOut: false,
      });
    });
  });
}
