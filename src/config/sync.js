/**
 * sync.js — Synchronizes active orchestrator and worker model configuration
 * to project-level instruction files (.codex/agents/reviewer.toml and .codex/config.toml).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
 * Synchronize .codex/agents/reviewer.toml and .codex/config.toml in the target workspace
 * so that the reviewer subagent and Codex session reflect the active orchestrator and worker models.
 *
 * @param {string} [workspaceDir] - Workspace directory (defaults to cwd)
 * @param {Object} [customConfig] - Optional loaded config object
 */
export function syncAgentConfigs(workspaceDir = process.cwd(), customConfig = null) {
  try {
    const config = customConfig || readStoredConfig();
    const orchModel = config.orchestratorModel || "chatgpt-6-astra";
    const orchEffort = config.reasoningEffort || "low";
    const workerModel = config.workerModel || "gemini-3.8-flash";
    const workerEffort = config.workerEffort || "medium";

    const codexDir = path.join(workspaceDir, ".codex");
    const agentsDir = path.join(codexDir, "agents");

    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }

    // 1. Sync reviewer.toml
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
    fs.writeFileSync(reviewerPath, reviewerContent, "utf-8");

    // 2. Sync config.toml if .codex exists
    const configTomlPath = path.join(codexDir, "config.toml");
    const configTomlContent = `# Kumo Cross-Provider Orchestrator Configuration
# Automatically synchronized with active user settings.
# Active Orchestrator: ${orchModel} (${orchEffort})
# Active Worker:       ${workerModel} (${workerEffort})

model = "${orchModel}"
model_reasoning_effort = "${orchEffort}"

approval_policy = "on-request"

[agents]
enabled = true
max_concurrent_threads_per_session = 4

[mcp_servers.gemini-bridge]
command = "node"
args = ["src/bridge/server.js"]
env = {}
`;
    fs.writeFileSync(configTomlPath, configTomlContent, "utf-8");
  } catch (err) {
    // Non-fatal if workspace is read-only or not yet initialized
  }
}
