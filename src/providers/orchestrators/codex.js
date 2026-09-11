/**
 * codex.js — OpenAI Codex orchestrator provider adapter.
 * Handles binary discovery, arguments building, and launching Codex with dynamic MCP bridge.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config/settings.js";
import { syncAgentConfigs } from "../../config/sync.js";
import { safeSpawn } from "../../utils/process.js";

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
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;

  // Windows: check local AppData, npm global, and PATH
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const appData = process.env.APPDATA || "";
    const candidates = [
      path.join(localAppData, "Programs", "OpenAI", "Codex", "codex.exe"),
      path.join(appData, "npm", "codex.cmd"),
      path.join(localAppData, "npm", "codex.cmd"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Codex", "codex.exe"),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }

  // Unix-like fallback
  const unixCandidates = [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
  ];

  for (const c of unixCandidates) {
    if (fs.existsSync(c)) return c;
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

  // Dynamically sync reviewer.toml and config.toml in the workspace
  try {
    syncAgentConfigs(workspace, config);
  } catch {
    /* fallback */
  }

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
  const workerModel = opts.workerModel || config.workerModel || "gemini-3.8-flash";
  const workerEffort = opts.workerEffort || config.workerEffort || "medium";
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
 * Launch Codex interactive session or headless task.
 */
export async function launch(opts = {}) {
  const { bin, args, env } = buildInvocation(opts);

  return new Promise((resolve, reject) => {
    const proc = safeSpawn(bin, args, {
      cwd: opts.workspace || process.cwd(),
      stdio: "inherit",
      env,
    });

    proc.on("close", (code) => {
      resolve(code ?? 0);
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
