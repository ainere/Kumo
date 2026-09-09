/**
 * codex.js — OpenAI Codex orchestrator provider adapter.
 * Handles binary discovery, arguments building, and launching Codex with dynamic MCP bridge.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config/settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROVIDER_INFO = {
  id: "codex",
  name: "OpenAI Codex CLI",
  defaultModel: "chatgpt-6-astra",
  supportedReasoning: ["low", "medium", "high", "max"],
};

/**
 * Locate the Codex executable on the system.
 */
export function findCodexBinary() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }

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

  return "codex";
}

/**
 * Build invocation options for Codex with dynamic workspace and MCP bridge.
 */
export function buildInvocation(opts = {}) {
  const config = loadConfig();
  const bin = findCodexBinary();
  const workspace = path.resolve(opts.workspace || process.cwd());
  const bridgeScript = path.resolve(__dirname, "../../bridge/server.js").replace(/\\/g, "/");
  const normalizedWorkspace = workspace.replace(/\\/g, "/");

  const args = [];

  if (opts.nonInteractive) {
    args.push("exec");
  }

  // Target directory
  args.push("-C", workspace);

  // Model & reasoning effort (supports ANY model name configured by user)
  const model = opts.model || config.orchestratorModel || "chatgpt-6-astra";
  const effort = opts.reasoningEffort || config.reasoningEffort || "low";
  args.push("-c", `model="${model}"`);
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }

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
    KUMO_WORKSPACE: workspace,
  };

  return { bin, args, env: childEnv };
}

/**
 * Launch Codex interactive session or headless task.
 */
export async function launch(opts = {}) {
  const { bin, args, env } = buildInvocation(opts);

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: opts.workspace || process.cwd(),
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });

    proc.on("close", (code) => {
      resolve(code ?? 0);
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
