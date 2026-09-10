/**
 * codex-launcher.js — Dispatches Codex CLI targeting any workspace with dynamic MCP bridge.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { findCodexBinary } from "../providers/orchestrators/codex.js";
export { findCodexBinary };

/**
 * Build Codex CLI arguments dynamically configuring the MCP bridge.
 *
 * @param {Object} opts
 * @param {string} opts.workspace       — Target project directory
 * @param {boolean} [opts.nonInteractive] — If true, use 'exec' subcommand
 * @param {string} [opts.prompt]         — Prompt for non-interactive mode
 * @returns {{ bin: string, args: string[], env: NodeJS.ProcessEnv }}
 */
export function buildCodexInvocation(opts) {
  const config = loadConfig();
  const bin = findCodexBinary();
  const workspace = path.resolve(opts.workspace || process.cwd());
  const bridgeScript = path.resolve(__dirname, "../bridge/server.js").replace(/\\/g, "/");
  const normalizedWorkspace = workspace.replace(/\\/g, "/");

  const args = [];

  if (opts.nonInteractive) {
    args.push("exec");
  }

  // Target directory
  args.push("-C", workspace);

  // Model & reasoning effort
  const model = config.orchestratorModel || "chatgpt-6-astra";
  const effort = config.reasoningEffort || "low";
  args.push("-c", `model="${model}"`);
  args.push("-c", `model_reasoning_effort="${effort}"`);

  // Approval policy
  const policy = config.approvalPolicy || "on-request";
  args.push("-a", policy);

  // Dynamic MCP bridge server registration
  const workerModel = config.workerModel || "gemini-3.8-flash";
  const workerEffort = config.workerEffort || "medium";
  args.push("-c", "mcp_servers.gemini-bridge.command='node'");
  args.push(
    "-c",
    `mcp_servers.gemini-bridge.args=['${bridgeScript}','--workspace','${normalizedWorkspace}','--model','${workerModel}','--effort','${workerEffort}']`
  );

  if (opts.nonInteractive && opts.prompt) {
    args.push(opts.prompt);
  }

  const childEnv = {
    ...process.env,
    ORCHESTRATOR_WORKSPACE: workspace,
    KUMO_WORKSPACE: workspace,
  };

  return { bin, args, env: childEnv };
}

/**
 * Launch Codex targeting the workspace with stdio inherited.
 *
 * @param {Object} opts
 * @param {string} opts.workspace
 * @param {boolean} [opts.nonInteractive]
 * @param {string} [opts.prompt]
 * @returns {Promise<number>} exit code
 */
export async function launchCodex(opts) {
  const { bin, args, env } = buildCodexInvocation(opts);

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts.workspace || process.cwd(),
      stdio: "inherit",
      env,
      shell: false,
    });

    proc.on("close", (code) => {
      resolve(code ?? 0);
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
