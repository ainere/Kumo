/**
 * agy-client.js — Orchestrator client adapter for Google Antigravity / Gemini CLI (`agy`).
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
import { getCliBinary, getAgyUsage } from "../../bridge/agy-runner.js";
import { safeSpawn } from "../../utils/process.js";
import { loadConfig, supportsEffort } from "../../config/settings.js";

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
    this.isTurnActive = false;
    this._pendingToolCallIds = new Map();
  }

  /**
   * Start the background `agy` process in stream-json mode.
   */
  async start() {
    return new Promise((resolve, reject) => {
      const args = [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
      ];

      if (this.activeModel) {
        args.push("--model", this.activeModel);
      }

      if (this.activeEffort && supportsEffort(this.activeModel)) {
        args.push("--effort", this.activeEffort);
      }

      try {
        this.proc = safeSpawn(this.bin, args, {
          cwd: this.workspace,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            ...this.options.env,
          },
        });
      } catch (err) {
        return reject(new Error(`Failed to spawn Antigravity orchestrator at '${this.bin}': ${err.message}`));
      }

      this.proc.stdout.on("data", (chunk) => this._handleStdout(chunk));
      this.proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        this.emit("stderr", text);
        if (/wsarecv|connection was forcibly closed|invalid model selection|streamGenerateContent/i.test(text)) {
          this.emit("server_error", {
            message: `Antigravity error: ${text.trim()}`,
          });
        }
      });

      this.proc.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });

      this.proc.on("close", (code) => {
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

    if (this.proc && (modelChanged || effortChanged || workspaceChanged)) {
      await this.stop();
      await this.start();
    }
    return { ok: true, threadId: this.conversationId || "agy-session" };
  }

  /**
   * Submit a prompt to the stream-json agent turn.
   */
  async startTurn(prompt, { model, effort } = {}) {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      await this.start();
    }

    this.isTurnActive = true;
    const msg = JSON.stringify({
      event: "user",
      message: {
        content: prompt,
      },
    }) + "\n";

    this.proc.stdin.write(msg);
    return { ok: true };
  }

  /**
   * Interrupt active turn.
   */
  async interruptTurn() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGINT");
      } catch {
        /* ignore */
      }
    }
    this.isTurnActive = false;
    this.emit("turn_completed");
  }

  /**
   * Retrieve live rate limits snapshot.
   */
  async getRateLimits() {
    try {
      const usage = await getAgyUsage();
      if (!usage) return null;

      const isClaudeOrGpt = Boolean(this.activeModel && /claude|gpt/i.test(this.activeModel));
      const usedPercent = isClaudeOrGpt
        ? (usage.claudeGptWeeklyPercent ?? usage.geminiWeeklyPercent ?? 0)
        : (usage.geminiWeeklyPercent ?? usage.claudeGptWeeklyPercent ?? 0);
      const resetTime = isClaudeOrGpt
        ? (usage.claudeGptWeeklyResetFormatted || "weekly")
        : (usage.geminiWeeklyResetFormatted || "weekly");

      return {
        usedPercent,
        remainingPercent: Math.max(0, 100 - usedPercent),
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
        if (!callId) {
          const queue = this._pendingToolCallIds.get(toolName);
          if (queue && queue.length > 0) {
            callId = queue.shift();
          } else {
            callId = randomUUID();
          }
        }

        if (process.env.KUMO_DEBUG) {
          console.error(`[KUMO_DEBUG] agy-client tool_call completed: ${toolName} (${callId})`);
        }

        this.emit("item_completed", {
          item: {
            id: callId,
            type: "mcp_tool_call",
            name: toolName,
          },
        });
      } else if (isToolEvent) {
        const toolName = update.tool_name || update.tool || update.name || "worker_tool";
        const callId = update.id || update.call_id || randomUUID();
        if (!this._pendingToolCallIds.has(toolName)) {
          this._pendingToolCallIds.set(toolName, []);
        }
        this._pendingToolCallIds.get(toolName).push(callId);

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
      if (res.status === "ERROR" && res.error) {
        this.emit("server_error", { message: res.error });
      }
      this.emit("turn_completed");
      return;
    }
  }

  /**
   * Terminate background process cleanly.
   */
  async stop() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
}
