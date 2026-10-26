/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * agy-client.js — Orchestrator client adapter for Google Antigravity (`agy`).
 *
 * Runs `agy --input-format stream-json --output-format stream-json` in the background,
 * translating line-delimited JSON stream events into standard Orchestrator client events:
 * `delta`, `reasoning`, `item_started`, `item_completed`, `turn_completed`.
 *
 * Supports all Antigravity models including Claude Opus 4.6 Thinking, Claude Sonnet 4.6,
 * Gemini 3.8 Flash, Gemini 3.7 Flash, and GPT-OSS 120B under Google AI Pro subscription.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getCliBinary, getAgyUsage, isArgonModel } from "../../bridge/agy-runner.js";
import { safeSpawn, childEnvFor, stopProcessTree } from "../../utils/process.js";
import { supportsEffort } from "../../config/settings.js";
import { agyEffort } from "../../config/models.js";
import { ensureAntigravityBridgeConfig } from "../../config/sync.js";

function getTaskSignature(raw) {
  if (!raw) return "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed.task || parsed.prompt || parsed.query || raw.trim();
    } catch {
      return raw.trim();
    }
  }
  if (typeof raw === "object") {
    return raw.task || raw.prompt || raw.query || JSON.stringify(raw);
  }
  return String(raw);
}

export class AgyAppClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bin = options.bin || getCliBinary();
    this.proc = null;
    this.buffer = "";
    this.conversationId = null;
    this.activeModel = options.model || null;
    this.activeEffort = options.effort || null;
    this.workerModel = options.workerModel || null;
    this.workerEffort = options.workerEffort || null;
    this.workspace = options.workspace || process.cwd();
    this.safetyMode =
      options.safetyMode ||
      process.env.KUMO_SAFETY_MODE ||
      options.config?.safetyMode ||
      "autonomous";
    this.isTurnActive = false;
    this._pendingToolCallIds = new Map();
    // Whether the running process has taken a turn: a new thread only needs
    // a fresh process when the current one already holds a conversation.
    this._hadTurn = false;
  }

  /**
   * Start the background `agy` process in stream-json mode.
   */
  async start() {
    return new Promise((resolve, reject) => {
      const args = [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
      ];

      // Permission bypass is only legitimate in autonomous mode; diff-review and
      // interactive both require the CLI to stop before touching the workspace.
      if (this.safetyMode === "autonomous") {
        args.push("--dangerously-skip-permissions");
      }

      if (this.activeModel) {
        args.push("--model", this.activeModel);
      }

      if (this.activeEffort && supportsEffort(this.activeModel)) {
        args.push("--effort", agyEffort(this.activeEffort));
      }

      // Reopen the conversation this client is on (a resumed chat, or a
      // restart for a model switch) instead of starting an empty one.
      if (this.conversationId) {
        args.push("--conversation", this.conversationId);
      }

      // Antigravity takes MCP servers only from the workspace file, so the
      // session workspace must name the bridge before agy starts.
      if (ensureAntigravityBridgeConfig(this.workspace)) {
        this.emit("notice", `Added kumo-bridge to ${path.join(this.workspace, ".agents", "mcp_config.json")}`);
      }

      try {
        this.proc = safeSpawn(this.bin, args, {
          cwd: this.workspace,
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnvFor("antigravity", this.options.env || {}),
        });
      } catch (err) {
        return reject(new Error(`Failed to spawn Antigravity orchestrator at '${this.bin}': ${err.message}`));
      }

      this.proc.stdout.on("data", (chunk) => this._handleStdout(chunk));
      this.proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        this.emit("stderr", text);
        // Only a fatal error ends the turn. Connection resets are often
        // retried by agy itself; ending the turn on them let the next prompt
        // land in a session that was still working on this one.
        if (/invalid model selection/i.test(text)) {
          this.emit("server_error", { message: `Antigravity error: ${text.trim()}` });
        } else if (/wsarecv|connection was forcibly closed|streamGenerateContent/i.test(text)) {
          this.emit("warning", { message: `Antigravity: ${text.trim()}` });
        }
      });

      const proc = this.proc;
      proc.on("error", (err) => {
        // A bare emit("error") with no listener throws and kills the REPL.
        if (this.listenerCount("error") > 0) this.emit("error", err);
        reject(err);
      });

      proc.on("close", (code) => {
        // A process replaced by startThread() must not report the new one as dead.
        if (this.proc !== proc) return;
        this.proc = null;
        this.isTurnActive = false;
        this.emit("close", code);
      });

      // Quick liveness check
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          resolve();
        } else {
          reject(new Error(`Antigravity orchestrator process exited immediately with '${this.bin}'`));
        }
      }, 200);
    });
  }

  /**
   * Configure active thread and parameters. Restarts process if model/workspace changed.
   */
  async startThread({ workspace, model, reasoningEffort, workerModel, workerEffort } = {}) {
    const modelChanged = Boolean(model && model !== this.activeModel);
    const effortChanged = Boolean(reasoningEffort && reasoningEffort !== this.activeEffort);
    const workspaceChanged = Boolean(workspace && workspace !== this.workspace);

    if (workspace) this.workspace = workspace;
    if (model) this.activeModel = model;
    if (reasoningEffort) this.activeEffort = reasoningEffort;
    if (workerModel) this.workerModel = workerModel;
    if (workerEffort) this.workerEffort = workerEffort;

    // A new thread is a new conversation. The process used to be kept when
    // nothing else changed, so /new carried the old conversation on.
    const hadConversation = this._hadTurn || Boolean(this.conversationId);
    this.conversationId = null;
    if (this.proc && (hadConversation || modelChanged || effortChanged || workspaceChanged)) {
      await this.stop();
      await this.start();
    }
    this._hadTurn = false;
    return { ok: true, threadId: null };
  }

  /**
   * Reopen an earlier conversation (`agy --conversation <id>`).
   *
   * @param {{ threadId: string, workspace?: string, model?: string, reasoningEffort?: string }} opts
   */
  async resumeThread({ threadId, workspace, model, reasoningEffort }) {
    if (workspace) this.workspace = workspace;
    if (model) this.activeModel = model;
    if (reasoningEffort) this.activeEffort = reasoningEffort;
    this.conversationId = threadId;
    if (this.proc) await this.stop();
    await this.start();
    this._hadTurn = true;
    return { ok: true, threadId, resumed: true };
  }

  /**
   * Switch model or effort and keep the conversation: agy fixes both when it
   * starts, so the process restarts on the same conversation.
   *
   * @param {{ model?: string, reasoningEffort?: string }} opts
   */
  async applyModel({ model, reasoningEffort } = {}) {
    const changed =
      Boolean(model && model !== this.activeModel) || Boolean(reasoningEffort && reasoningEffort !== this.activeEffort);
    if (model) this.activeModel = model;
    if (reasoningEffort) this.activeEffort = reasoningEffort;
    if (changed && this.proc) {
      await this.stop();
      await this.start();
    }
  }

  /** The conversation id agy reported, which `resumeThread` accepts later. */
  currentThreadId() {
    return this.conversationId;
  }

  /**
   * Submit a prompt to the stream-json agent turn.
   *
   * Resolves as soon as the prompt is written — the turn is still running. Its
   * end is the `result` event, reported as `turn_completed`. Returning `ok`
   * here used to make callers treat the turn as already finished.
   */
  async startTurn(prompt, { model, effort } = {}) {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      await this.start();
    }

    this.isTurnActive = true;
    this._hadTurn = true;
    const msg = JSON.stringify({
      event: "user",
      message: {
        content: prompt,
      },
    }) + "\n";

    this.proc.stdin.write(msg);
    return { submitted: true };
  }

  /**
   * Interrupt active turn. stream-json mode has no per-turn cancel, so the
   * process is stopped; the next turn starts a fresh one.
   */
  async interruptTurn() {
    const proc = this.proc;
    this.proc = null;
    stopProcessTree(proc, "SIGINT");
    this.isTurnActive = false;
    this.emit("turn_completed", { ok: false, reason: "interrupted" });
  }

  /**
   * Retrieve live rate limits snapshot.
   */
  async getRateLimits() {
    try {
      const usage = await getAgyUsage();
      if (!usage) return null;

      const isClaudeOrGpt = Boolean(this.activeModel && /claude|gpt/i.test(this.activeModel));
      // Gemini 4 Argon draws on its own weekly limit; the family figure only
      // stands in when agy did not report one.
      const argon = !isClaudeOrGpt && isArgonModel(this.activeModel);
      // agy reports what is left ("Weekly Limit Remaining 99%"); this used to
      // be read as the used share, so a full quota showed as exhausted.
      const remainingPercent = isClaudeOrGpt
        ? (usage.claudeGptWeeklyPercent ?? usage.geminiWeeklyPercent ?? 0)
        : argon
          ? (usage.geminiArgonWeeklyPercent ?? usage.geminiWeeklyPercent ?? usage.claudeGptWeeklyPercent ?? 0)
          : (usage.geminiWeeklyPercent ?? usage.claudeGptWeeklyPercent ?? 0);
      const resetTime = isClaudeOrGpt
        ? (usage.claudeGptWeeklyResetFormatted || "weekly")
        : argon && usage.geminiArgonWeeklyPercent != null
          ? (usage.geminiArgonWeeklyResetFormatted || "weekly")
          : (usage.geminiWeeklyResetFormatted || "weekly");

      return {
        usedPercent: Math.max(0, 100 - remainingPercent),
        remainingPercent,
        planType: "Google AI Pro",
        resetFormatted: resetTime,
        creditsAvailable: 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse NDJSON lines from agy stdout.
   */
  _handleStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // Keep partial line in buffer

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const data = JSON.parse(line);
        this._handleStreamEvent(data);
      } catch {
        // Non-JSON output fallback
      }
    }
  }

  /**
   * Dispatch parsed stream event to client listeners.
   */
  _handleStreamEvent(data) {
    const eventType = data.event;

    if (eventType === "init") {
      this.conversationId = data.conversation_id;
      return;
    }

    if (eventType === "step_update") {
      const update = data.step_update || {};
      if (update.conversation_id) {
        this.conversationId = update.conversation_id;
      }

      // 1. Text delta
      if (update.text_delta) {
        this.emit("delta", update.text_delta);
      }

      // 2. Reasoning indicator
      if (update.step_type === "thinking" || update.thinking) {
        this.emit("reasoning", update.text_delta || update.thinking || "");
      }

      // 3. Tool invocation
      const isToolEvent = update.step_type === "tool_call" || update.tool_call || update.step_type === "call_mcp_tool";
      if (isToolEvent && update.state === "DONE") {
        const toolName = update.tool_name || update.tool || update.name || "worker_tool";
        let callId = update.id || update.call_id;
        const queue = this._pendingToolCallIds.get(toolName) || [];
        const signature = getTaskSignature(update.tool_input || update.args);

        if (callId) {
          const idx = queue.findIndex((entry) => entry.id === callId);
          if (idx !== -1) queue.splice(idx, 1);
        } else {
          let matched = null;
          if (signature) {
            const idx = queue.findIndex((entry) => entry.signature && entry.signature === signature);
            if (idx !== -1) {
              matched = queue.splice(idx, 1)[0];
            }
          }
          if (!matched && queue.length > 0) {
            matched = queue.shift();
          }
          callId = matched ? matched.id : randomUUID();
        }

        if (process.env.KUMO_DEBUG) {
          console.error(`[KUMO_DEBUG] agy-client tool_call completed: ${toolName} (${callId})`);
        }

        this.emit("item_completed", {
          item: {
            id: callId,
            type: "mcp_tool_call",
            name: toolName,
            arguments: update.tool_input || update.args || {},
          },
        });
      } else if (isToolEvent) {
        const toolName = update.tool_name || update.tool || update.name || "worker_tool";
        const callId = update.id || update.call_id || randomUUID();
        const signature = getTaskSignature(update.tool_input || update.args);

        if (!this._pendingToolCallIds.has(toolName)) {
          this._pendingToolCallIds.set(toolName, []);
        }
        this._pendingToolCallIds.get(toolName).push({
          id: callId,
          signature,
          timestamp: Date.now(),
        });

        if (process.env.KUMO_DEBUG) {
          console.error(`[KUMO_DEBUG] agy-client tool_call started: ${toolName} (${callId})`);
        }

        const workerModel = update.tool_input?.model || this.workerModel || null;
        const workerEffort = update.tool_input?.effort || this.workerEffort || null;

        this.emit("item_started", {
          item: {
            id: callId,
            type: "mcp_tool_call",
            name: toolName,
            model: workerModel,
            effort: workerEffort,
            arguments: update.tool_input || update.args || {},
          },
        });
      }
      return;
    }

    if (eventType === "result") {
      this.isTurnActive = false;
      const res = data.result || {};
      const failed = res.status === "ERROR";
      this.emit(
        "turn_completed",
        failed ? { ok: false, reason: res.error || "Antigravity reported an error" } : { ok: true }
      );
      return;
    }
  }

  /**
   * Terminate background process cleanly.
   */
  async stop() {
    const proc = this.proc;
    this.proc = null;
    stopProcessTree(proc);
  }
}
