/**
 * claude-client.js — Orchestrator client adapter for Anthropic Claude Code CLI (`claude`).
 * Completely open model selection: supports any model passed via options or turn args without hardcoding.
 *
 * Each turn is one `claude -p` run of the official CLI, on the user's own
 * Claude login. What makes it an orchestrator rather than a one-shot chat:
 *   - `--mcp-config` hands it Kumo's worker bridge (Claude Code reads project
 *     servers from `.mcp.json`, never from `.claude/mcp.json`, so a file in the
 *     workspace was never picked up), and `--strict-mcp-config` keeps the
 *     user's other servers — which it could not call headlessly anyway — from
 *     starting on every turn;
 *   - `--allowedTools mcp__kumo-bridge` lets it call those tools headlessly —
 *     print mode denies any tool that would need an interactive permission;
 *   - `--session-id` on the first turn and `--resume` afterwards keep one
 *     conversation, so later turns see the earlier ones;
 *   - `--output-format stream-json` reports text as it is written, each tool
 *     call, the turn's result and the account's rate limits. Plain text output
 *     arrived all at once at the end and showed no worker calls.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GenericAppClient } from "./generic-client.js";
import { findClaudeBinary, CLAUDE_EFFORTS } from "../workers/claude.js";
import { BRIDGE_SERVER_PATH } from "../../config/sync.js";
import { kumoHome, ensureDir, atomicWriteJson } from "../../config/paths.js";
import { formatResetTime } from "../../utils/ui.js";
import { nodeCommand } from "../../core/node-command.js";

/** Permission rule that matches every tool the bridge exposes. */
export const BRIDGE_TOOL_RULE = "mcp__kumo-bridge";

/**
 * Variables that make Claude Code bill an API key or token instead of the
 * user's subscription login. Print mode uses ANTHROPIC_API_KEY without asking,
 * so a key exported for some other tool silently switched billing.
 */
export const CLAUDE_AUTH_OVERRIDE_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** Split `mcp__<server>__<tool>` into its parts; null for built-in tools. */
export function parseMcpToolName(name) {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(name || ""));
  return match ? { server: match[1], tool: match[2] } : null;
}

/**
 * Turn a stream-json `tool_use` block into the item shape the rest of Kumo
 * reads (see items.js): MCP calls become `mcpToolCall`, the same type Codex
 * reports, so worker calls show up the same way for both orchestrators.
 */
function toolItem(block, status) {
  const mcp = parseMcpToolName(block.name);
  return mcp
    ? { id: block.id, type: "mcpToolCall", server: mcp.server, tool: mcp.tool, arguments: block.input || {}, status }
    : { id: block.id, type: "toolUse", name: block.name, arguments: block.input || {}, status };
}

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
    this.rateLimit = null;
    this._warnedApiKey = false;
    this._resetTurnState();
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
   * Continue an earlier conversation: the next turn runs with `--resume`.
   *
   * @param {{ threadId: string, workspace?: string, model?: string, reasoningEffort?: string }} opts
   */
  async resumeThread(opts) {
    await super.startThread(opts);
    this.sessionId = opts.threadId;
    this.sessionStarted = true;
    this._removeMcpConfig();
    return { ok: true, threadId: this.sessionId, resumed: true };
  }

  /** The id of a conversation that exists and can be resumed, or null. */
  currentThreadId() {
    return this.sessionStarted ? this.sessionId : null;
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
    const node = nodeCommand();
    atomicWriteJson(file, {
      mcpServers: {
        "kumo-bridge": {
          command: node.command,
          args: [BRIDGE_SERVER_PATH, "--workspace", this.workspace],
          env: {
            ...node.env,
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

  buildTurn(prompt, { model, effort } = {}) {
    if (!this.sessionId) this.sessionId = randomUUID();
    this._resetTurnState();
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--mcp-config", this._mcpConfigFile(),
      "--strict-mcp-config",
      "--allowedTools", BRIDGE_TOOL_RULE,
    ];
    if (model) {
      args.push("--model", model);
    }
    if (effort && CLAUDE_EFFORTS.includes(effort)) {
      args.push("--effort", effort);
    }
    args.push(this.sessionStarted ? "--resume" : "--session-id", this.sessionId);
    // The prompt goes over stdin: it may span lines, which argv cannot carry
    // through a Windows .cmd shim.
    return { args, stdin: prompt };
  }

  childEnv(extra = {}) {
    const env = super.childEnv(extra);
    for (const name of CLAUDE_AUTH_OVERRIDE_ENV) delete env[name];
    return env;
  }

  _resetTurnState() {
    this._lineBuffer = "";
    this._result = null;
    this._toolUses = new Map();
    this._streamedMessages = new Set();
    this._textMessageId = null;
    this._emittedText = false;
  }

  onStdout(text) {
    this._lineBuffer += text;
    let newline;
    while ((newline = this._lineBuffer.indexOf("\n")) !== -1) {
      const line = this._lineBuffer.slice(0, newline).trim();
      this._lineBuffer = this._lineBuffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Not stream-json (an older CLI, or a diagnostic line): show it as is.
        this._emitText(null, `${line}\n`);
        continue;
      }
      this._handleStreamEvent(event);
    }
  }

  /**
   * Emit answer text, separating consecutive assistant messages — text
   * written before and after a tool call would otherwise run together.
   */
  _emitText(messageId, text) {
    if (!text) return;
    if (messageId && messageId !== this._textMessageId) {
      if (this._emittedText) this.emit("delta", "\n\n");
      this._textMessageId = messageId;
    }
    this._emittedText = true;
    this.emit("delta", text);
  }

  _handleStreamEvent(event) {
    // Events from a subagent (the Task tool) carry the id of the tool call
    // that started it; only the orchestrator's own messages are its answer.
    if (event.parent_tool_use_id) return;

    switch (event.type) {
      case "system":
        if (event.subtype === "init") this._handleInit(event);
        break;
      case "stream_event": {
        const e = event.event || {};
        if (e.type !== "content_block_delta") break;
        if (event.api_message_id) this._streamedMessages.add(event.api_message_id);
        if (e.delta?.type === "text_delta") this._emitText(event.api_message_id || null, e.delta.text);
        else if (e.delta?.type === "thinking_delta") this.emit("reasoning", e.delta.thinking || "");
        break;
      }
      case "assistant": {
        const message = event.message || {};
        for (const block of message.content || []) {
          if (block.type === "tool_use") {
            const item = toolItem(block, "inProgress");
            this._toolUses.set(block.id, block);
            this.emit("item_started", { item });
          } else if (block.type === "text" && !this._streamedMessages.has(message.id)) {
            // No partial messages arrived for this one: emit it whole.
            this._emitText(message.id || null, block.text);
          }
        }
        break;
      }
      case "user": {
        for (const block of event.message?.content || []) {
          if (block.type !== "tool_result") continue;
          const use = this._toolUses.get(block.tool_use_id);
          if (!use) continue;
          this._toolUses.delete(block.tool_use_id);
          this.emit("item_completed", { item: toolItem(use, block.is_error ? "failed" : "completed") });
        }
        break;
      }
      case "rate_limit_event":
        if (event.rate_limit_info) this.rateLimit = event.rate_limit_info;
        break;
      case "result": {
        const ok = event.subtype === "success" && !event.is_error;
        this._result = ok
          ? { ok: true }
          : {
              ok: false,
              reason:
                (typeof event.result === "string" && event.result.trim()) ||
                event.api_error_status ||
                event.subtype ||
                "Claude Code reported an error",
            };
        break;
      }
      default:
        break;
    }
  }

  _handleInit(event) {
    if (event.session_id) this.sessionId = event.session_id;

    const bridge = (event.mcp_servers || []).find((s) => s.name === "kumo-bridge");
    if (!bridge || bridge.status !== "connected") {
      this.emit("warning", {
        message: `kumo-bridge ${bridge ? bridge.status : "is missing"}; worker tools are unavailable this turn.`,
      });
    }

    // "none" means the subscription login is in use. Anything else (an
    // apiKeyHelper, a key from settings) bills an API account instead.
    if (event.apiKeySource && event.apiKeySource !== "none" && !this._warnedApiKey) {
      this._warnedApiKey = true;
      this.emit("warning", {
        message: `Claude Code is using an API key (${event.apiKeySource}), not your Claude subscription login.`,
      });
    }
  }

  turnResult(code, stderrTail) {
    // Prefer what Claude Code said about the turn; the exit code only covers
    // a run that ended before it could say anything.
    if (this._result) return this._result;
    const base = super.turnResult(code, stderrTail);
    return base.ok ? { ok: false, reason: "claude exited without reporting a result" } : base;
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

  /**
   * The subscription's usage from the last turn's `rate_limit_event`: the
   * window closest to its limit, in the shape the quota display reads.
   * Null until a turn has run.
   */
  async getRateLimits() {
    const windows = this.rateLimit?.unifiedWindows;
    if (!windows) return null;
    const candidates = [
      ["five_hour", 300],
      ["seven_day", 10080],
    ]
      .filter(([key]) => windows[key] && typeof windows[key].utilization === "number")
      .map(([key, minutes]) => ({ ...windows[key], windowMinutes: minutes }));
    if (candidates.length === 0) return null;
    const tightest = candidates.reduce((a, b) => (b.utilization > a.utilization ? b : a));
    const usedPercent = Math.round(Math.min(1, Math.max(0, tightest.utilization)) * 100);
    return {
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt: tightest.resetsAt,
      resetFormatted: formatResetTime(tightest.resetsAt),
      windowMinutes: tightest.windowMinutes,
      planType: "Claude subscription",
      creditsAvailable: 0,
    };
  }

  async stop() {
    await super.stop();
    this._removeMcpConfig();
  }
}
