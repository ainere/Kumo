/**
 * sync.js — Synchronizes active orchestrator and worker model configuration
 * to project-level instruction and MCP configuration files.
 *
 * Supports Codex (.codex/config.toml), Antigravity (.agents/mcp_config.json),
 * and Claude Code (.claude/mcp.json).
 *
 * The MCP bridge server is always resolved from *this* Kumo installation, never
 * from the target workspace — the workspace being synchronized is almost never
 * the Kumo repository itself.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { detectProviderForModel } from "./settings.js";
import { configFile, atomicWriteText, atomicWriteJson } from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bridge server shipped with this Kumo installation. */
export const BRIDGE_SERVER_PATH = path.resolve(__dirname, "../bridge/server.js");

const TOML_BEGIN = "# >>> kumo managed block >>>";
const TOML_END = "# <<< kumo managed block <<<";
const LEGACY_TOML_HEADER = "# Kumo Cross-Provider Orchestrator Configuration";

function readStoredConfig() {
  try {
    const file = configFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * Serialize a value for interpolation into a TOML basic string.
 * Throws on characters that would break out of the string — callers validate
 * these values upstream, so a hit here is a bug, not user error.
 *
 * @param {*} v
 * @returns {string}
 */
export function tomlString(v) {
  const s = String(v ?? "");
  if (/["\r\n\\]/.test(s)) {
    throw new Error(`Value cannot be serialized into TOML: ${JSON.stringify(s)}`);
  }
  return s;
}

/**
 * Write a text file atomically (tmp + rename), using the process umask.
 *
 * @param {string} p
 * @param {string} content
 */
function writeFileAtomic(p, content) {
  atomicWriteText(p, content, undefined);
}

/**
 * Write a JSON file, merging top-level `mcpServers` with any existing file.
 * Missing/corrupt existing JSON is treated as `{}`.
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
  atomicWriteJson(p, merged, undefined);
}

/**
 * Write Kumo's settings into a delimited managed region of a TOML file,
 * preserving every other line the user authored.
 *
 * The block contains only key/value pairs (dotted keys, no `[table]` headers),
 * so it must appear before any table header in the file — TOML scopes bare keys
 * to the most recent table. New blocks are therefore prepended, not appended.
 *
 * @param {string} p
 * @param {string} blockContent
 */
export function writeTomlManagedBlock(p, blockContent) {
  const wrapped = `${TOML_BEGIN}\n${blockContent.trim()}\n${TOML_END}\n`;

  let existing = null;
  try {
    if (fs.existsSync(p)) existing = fs.readFileSync(p, "utf-8");
  } catch {
    existing = null;
  }

  if (existing === null) {
    writeFileAtomic(p, wrapped);
    return;
  }

  const start = existing.indexOf(TOML_BEGIN);
  const end = existing.indexOf(TOML_END);
  if (start !== -1 && end !== -1 && end > start) {
    const tail = existing.slice(end + TOML_END.length).replace(/^\r?\n/, "");
    writeFileAtomic(p, existing.slice(0, start) + wrapped + tail);
    return;
  }

  if (existing.trimStart().startsWith(LEGACY_TOML_HEADER)) {
    // Pre-sentinel file generated wholly by Kumo; nothing user-authored to keep.
    writeFileAtomic(p, wrapped);
    return;
  }

  writeFileAtomic(p, `${wrapped}\n${existing.replace(/^\r?\n/, "")}`);
}

/**
 * Synchronize orchestrator and worker configs across active providers.
 *
 * @param {string} [workspaceDir] - Workspace directory (defaults to cwd)
 * @param {Object} [customConfig] - Optional loaded config object
 */
export function syncAgentConfigs(workspaceDir = process.cwd(), customConfig = null) {
  if (process.env.KUMO_NO_SYNC === "1") return;
  try {
    const config = customConfig || readStoredConfig();
    const orchModel = tomlString(config.orchestratorModel || "chatgpt-6-astra");
    const orchEffort = tomlString(config.reasoningEffort || "low");
    const orchProvider = tomlString(config.orchestratorProvider || detectProviderForModel(orchModel));

    const workerModel = tomlString(config.workerModel || "gemini-3.8-flash");
    const workerEffort = tomlString(config.workerEffort || "medium");
    const workerProvider = tomlString(config.workerProvider || detectProviderForModel(workerModel));
    const approvalPolicy = tomlString(config.approvalPolicy || "on-request");

    const isAntigravity = (p) => p === "antigravity" || p === "gemini" || p === "agy";

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
      writeFileAtomic(reviewerPath, reviewerContent);

      const configTomlPath = path.join(codexDir, "config.toml");
      const managedBlock = `${LEGACY_TOML_HEADER}
# Automatically synchronized with active user settings.
# Everything between the kumo sentinels is regenerated; edit outside the block.
# Active Orchestrator: ${orchModel} (${orchEffort}) [${orchProvider}]
# Active Worker:       ${workerModel} (${workerEffort}) [${workerProvider}]

model = "${orchModel}"
model_reasoning_effort = "${orchEffort}"
approval_policy = "${approvalPolicy}"

agents.enabled = true
agents.max_concurrent_threads_per_session = 4

mcp_servers.kumo-bridge.command = "node"
mcp_servers.kumo-bridge.args = [${JSON.stringify(BRIDGE_SERVER_PATH)}]
mcp_servers.kumo-bridge.env = { KUMO_WORKSPACE = ${JSON.stringify(workspaceDir)} }`;
      writeTomlManagedBlock(configTomlPath, managedBlock);
    }

    // 2. Sync Antigravity / Gemini configurations (.agents/mcp_config.json & ~/.gemini/config/mcp_config.json)
    const agentsWorkspaceDir = path.join(workspaceDir, ".agents");
    if (
      fs.existsSync(agentsWorkspaceDir) ||
      isAntigravity(orchProvider) ||
      isAntigravity(workerProvider)
    ) {
      if (!fs.existsSync(agentsWorkspaceDir)) {
        fs.mkdirSync(agentsWorkspaceDir, { recursive: true });
      }
      const agyMcpPath = path.join(agentsWorkspaceDir, "mcp_config.json");
      const agyMcpConfig = {
        mcpServers: {
          "kumo-bridge": {
            command: "node",
            args: [BRIDGE_SERVER_PATH],
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
                  args: [BRIDGE_SERVER_PATH],
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
    if (orchProvider === "claude" || workerProvider === "claude") {
      const claudeDir = path.join(workspaceDir, ".claude");
      if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
      }
      const claudeMcpPath = path.join(claudeDir, "mcp.json");
      const claudeMcpConfig = {
        mcpServers: {
          "kumo-bridge": {
            command: "node",
            args: [BRIDGE_SERVER_PATH],
            env: {
              KUMO_WORKSPACE: workspaceDir,
            },
          },
        },
      };
      writeJsonMerged(claudeMcpPath, claudeMcpConfig);
    }
  } catch {
    // Non-fatal if workspace is read-only or not yet initialized
  }
}
