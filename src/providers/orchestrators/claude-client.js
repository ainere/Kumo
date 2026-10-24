/**
 * claude-client.js — Orchestrator client adapter for Anthropic Claude Code CLI (`claude`).
 * Completely open model selection: supports any model passed via options or turn args without hardcoding.
 *
 * Each turn is one `claude -p` run. Three things make it an orchestrator rather
 * than a one-shot chat:
 *   - `--mcp-config` hands it Kumo's worker bridge (Claude Code reads project
 *     servers from `.mcp.json`, never from `.claude/mcp.json`, so a file in the
 *     workspace was never picked up);
 *   - `--allowedTools mcp__kumo-bridge` lets it call those tools headlessly —
 *     print mode denies any tool that would need an interactive permission;
 *   - `--session-id` on the first turn and `--resume` afterwards keep one
 *     conversation, so later turns see the earlier ones.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GenericAppClient } from "./generic-client.js";
import { findClaudeBinary } from "../workers/claude.js";
import { BRIDGE_SERVER_PATH } from "../../config/sync.js";
import { kumoHome, ensureDir, atomicWriteJson } from "../../config/paths.js";

/** Permission rule that matches every tool the bridge exposes. */
export const BRIDGE_TOOL_RULE = "mcp__kumo-bridge";

export class ClaudeAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "claude",
      bin: options.bin || findClaudeBinary(),
    });
    this.sessionId = null;
    this.sessionStarted = false;
    this.mcpConfigPath = null;
  }

  async startThread(opts = {}) {
    await super.startThread(opts);
    // A new thread is a new conversation.
    this.sessionId = randomUUID();
    this.sessionStarted = false;
    this._removeMcpConfig();
    return { ok: true, threadId: this.sessionId };
  }

  /**
   * Write the per-session MCP config naming the bridge for this workspace.
   * Lives under the Kumo state directory, never in the user's repository.
   *
   * @returns {string}
   */
  _mcpConfigFile() {
    if (this.mcpConfigPath && fs.existsSync(this.mcpConfigPath)) return this.mcpConfigPath;
    const dir = path.join(kumoHome(), "run");
    ensureDir(dir);
    const file = path.join(dir, `claude-mcp-${process.pid}-${randomUUID()}.json`);
    atomicWriteJson(file, {
      mcpServers: {
        "kumo-bridge": {
          command: process.execPath,
          args: [BRIDGE_SERVER_PATH, "--workspace", this.workspace],
          env: {
            ...(this.options.env || {}),
            KUMO_WORKSPACE: this.workspace,
            ...(process.env.KUMO_HOME ? { KUMO_HOME: process.env.KUMO_HOME } : {}),
          },
        },
      },
    });
    this.mcpConfigPath = file;
    return file;
  }

  _removeMcpConfig() {
    if (!this.mcpConfigPath) return;
    try {
      fs.unlinkSync(this.mcpConfigPath);
    } catch {
      /* already gone */
    }
    this.mcpConfigPath = null;
  }

  buildTurn(prompt, { model } = {}) {
    if (!this.sessionId) this.sessionId = randomUUID();
    const args = ["-p", "--mcp-config", this._mcpConfigFile(), "--allowedTools", BRIDGE_TOOL_RULE];
    if (model) {
      args.push("--model", model);
    }
    args.push(this.sessionStarted ? "--resume" : "--session-id", this.sessionId);
    // The prompt goes over stdin: it may span lines, which argv cannot carry
    // through a Windows .cmd shim.
    return { args, stdin: prompt };
  }

  afterTurn(ok) {
    if (ok) {
      this.sessionStarted = true;
    } else if (!this.sessionStarted) {
      // The first turn failed, possibly before the session was saved; a fresh
      // id avoids resuming a conversation that may not exist.
      this.sessionId = randomUUID();
    }
  }

  async stop() {
    await super.stop();
    this._removeMcpConfig();
  }
}
