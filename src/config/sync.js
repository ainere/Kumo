/**
 * sync.js — Synchronizes active orchestrator and worker model configuration
 * to project-level instruction and MCP configuration files.
 *
 * Supports Codex (.codex/config.toml), Antigravity (.agents/mcp_config.json),
 * and Claude Code (.claude/mcp.json).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectProviderForModel } from "./settings.js";

const CONFIG_FILE = path.join(os.homedir(), ".kumo", "config.json");

function readStoredConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * Back up an existing file to `<path>.bak` (overwrites prior backup).
 *
 * @param {string} p
 */
function backupIfExists(p) {
  try {
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, `${p}.bak`);
    }
  } catch {
    /* non-fatal */
  }
}

/**
 * Write a text file with backup of any existing file.
 *
 * @param {string} p
 * @param {string} content
 */
function writeFileBacked(p, content) {
  backupIfExists(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

/**
 * Write a JSON file, merging top-level `mcpServers` with any existing file.
 * Missing/corrupt existing JSON is treated as `{}` (existing file backed up first).
 *
 * @param {string} p
 * @param {object} obj
 */
function writeJsonMerged(p, obj) {
  let old = {};
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, "utf-8").trim();
      old = raw ? JSON.parse(raw) : {};
      if (!old || typeof old !== "object") old = {};
    } catch {
      old = {};
    }
  }
  const merged = { ...old, ...obj };
  merged.mcpServers = { ...(old.mcpServers || {}), ...(obj.mcpServers || {}) };
  backupIfExists(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Synchronize orchestrator and worker configs across active providers.
 *
 * @param {string} [workspaceDir] - Workspace directory (defaults to cwd)
 * @param {Object} [customConfig] - Optional loaded config object
 */
export function syncAgentConfigs(workspaceDir = process.cwd(), customConfig = null) {
  try {
    const config = customConfig || readStoredConfig();
    const orchModel = config.orchestratorModel || "chatgpt-6-astra";
    const orchEffort = config.reasoningEffort || "low";
    const orchProvider = config.orchestratorProvider || detectProviderForModel(orchModel);

    const workerModel = config.workerModel || "gemini-3.8-flash";
    const workerEffort = config.workerEffort || "medium";
    const workerProvider = config.workerProvider || detectProviderForModel(workerModel);

    // 1. Sync Codex configurations (.codex/agents/reviewer.toml & .codex/config.toml)
    const codexDir = path.join(workspaceDir, ".codex");
    const agentsDir = path.join(codexDir, "agents");

    if (fs.existsSync(codexDir) || orchProvider === "codex" || workerProvider === "codex") {
      if (!fs.existsSync(agentsDir)) {
        fs.mkdirSync(agentsDir, { recursive: true });
      }

      const reviewerPath = path.join(agentsDir, "reviewer.toml");
      const reviewerContent = `name = "reviewer"
description = "Independent code reviewer. Uses the active orchestrator model to review code written by the execution worker for genuine cross-model review independence."

model = "${orchModel}"
model_reasoning_effort = "${orchEffort}"
sandbox_mode = "read-only"

developer_instructions = """
You are an independent code review subagent representing the Orchestrator (running on ${orchModel} with ${orchEffort} reasoning effort).

IMPORTANT: The code you are reviewing was written by the execution worker (running on ${workerModel} with ${workerEffort} reasoning effort).
Because you and the worker run on distinct models and contexts, you provide genuine cross-model independence to catch blind spots, regressions, and contract violations.

Review the actual change, not the intended story.

Prioritize:
- Correctness bugs
- Behavior regressions
- Security and permission issues
- Data loss or integrity risks
- Race/concurrency problems
- API or compatibility breaks
- Missing high-value tests

Rules:
- Avoid style-only comments unless they hide a real defect
- Do not edit files

For each finding include:
- Severity (Critical, Warning, Info)
- Exact file/symbol/line
- Why it is a problem
- A concrete fix or validation step

If there are no material findings, say so clearly and name any residual uncertainty.
"""
`;
      writeFileBacked(reviewerPath, reviewerContent);

      const configTomlPath = path.join(codexDir, "config.toml");
      const configTomlContent = `# Kumo Cross-Provider Orchestrator Configuration
# Automatically synchronized with active user settings.
# Active Orchestrator: ${orchModel} (${orchEffort}) [${orchProvider}]
# Active Worker:       ${workerModel} (${workerEffort}) [${workerProvider}]

model = "${orchModel}"
model_reasoning_effort = "${orchEffort}"

approval_policy = "on-request"

[agents]
enabled = true
max_concurrent_threads_per_session = 4

[mcp_servers.kumo-bridge]
command = "node"
args = ["${path.join(workspaceDir, "src", "bridge", "server.js").replace(/\\/g, "\\\\")}"]
env = {}
`;
      writeFileBacked(configTomlPath, configTomlContent);
    }

    // 2. Sync Antigravity / Gemini configurations (.agents/mcp_config.json & ~/.gemini/config/mcp_config.json)
    const agentsWorkspaceDir = path.join(workspaceDir, ".agents");
    if (fs.existsSync(agentsWorkspaceDir) || orchProvider === "antigravity" || orchProvider === "gemini") {
      if (!fs.existsSync(agentsWorkspaceDir)) {
        fs.mkdirSync(agentsWorkspaceDir, { recursive: true });
      }
      const agyMcpPath = path.join(agentsWorkspaceDir, "mcp_config.json");
      const agyMcpConfig = {
        mcpServers: {
          "kumo-bridge": {
            command: "node",
            args: [path.join(workspaceDir, "src", "bridge", "server.js")],
            env: {
              KUMO_WORKSPACE: workspaceDir,
            },
          },
        },
      };
      writeJsonMerged(agyMcpPath, agyMcpConfig);

      // Global gemini sync is opt-in (avoids leaking workspace paths on every save)
      if (process.env.KUMO_SYNC_GLOBAL_GEMINI === "1") {
        try {
          const geminiGlobalDir = path.join(os.homedir(), ".gemini", "config");
          if (fs.existsSync(geminiGlobalDir)) {
            const globalMcpPath = path.join(geminiGlobalDir, "mcp_config.json");
            writeJsonMerged(globalMcpPath, {
              mcpServers: {
                "kumo-bridge": {
                  command: "node",
                  args: [path.join(workspaceDir, "src", "bridge", "server.js")],
                  disabled: false,
                },
              },
            });
          }
        } catch {
          /* ignore */
        }
      }
    }

    // 3. Sync Claude Code configurations (.claude/mcp.json)
    if (orchProvider === "claude") {
      const claudeDir = path.join(workspaceDir, ".claude");
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      const claudeMcpPath = path.join(claudeDir, "mcp.json");
      const claudeMcpConfig = {
        mcpServers: {
          "kumo-bridge": {
            command: "node",
            args: [path.join(workspaceDir, "src", "bridge", "server.js")],
          },
        },
      };
      writeJsonMerged(claudeMcpPath, claudeMcpConfig);
    }
  } catch (err) {
    // Non-fatal if workspace is read-only or not yet initialized
  }
}
