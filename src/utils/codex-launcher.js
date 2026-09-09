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

/**
 * Locate the Codex executable on the system.
 * @returns {string}
 */
export function findCodexBinary() {
  // 1. Check environment variable override
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }

  // 2. Check ~/.codex/config.toml for CODEX_CLI_PATH
  const codexHomeConfig = path.join(os.homedir(), ".codex", "config.toml");
  if (fs.existsSync(codexHomeConfig)) {
    try {
      const content = fs.readFileSync(codexHomeConfig, "utf-8");
      const match = content.match(/CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/);
      if (match && fs.existsSync(match[1])) {
        return match[1];
      }
    } catch {
      /* ignore */
    }
  }

  // 3. Check Windows AppData Local location
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const codexBinDir = path.join(localAppData, "OpenAI", "Codex", "bin");
    if (fs.existsSync(codexBinDir)) {
      try {
        const subdirs = fs.readdirSync(codexBinDir);
        for (const sub of subdirs) {
          const candidate = path.join(codexBinDir, sub, "codex.exe");
          if (fs.existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 4. Default to 'codex' on PATH
  return "codex";
}

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
  args.push("-c", 'mcp_servers.gemini-bridge.command="node"');
  args.push(
    "-c",
    `mcp_servers.gemini-bridge.args=["${bridgeScript}","--workspace","${normalizedWorkspace}"]`
  );

  if (opts.nonInteractive && opts.prompt) {
    args.push(opts.prompt);
  }

  const childEnv = {
    ...process.env,
    ORCHESTRATOR_WORKSPACE: workspace,
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
