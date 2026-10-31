/**
 * copilot-client.js — Orchestrator client adapter for GitHub Copilot CLI (`gh copilot`).
 *
 * Each turn is one `gh copilot -p` run, on the user's own GitHub login. What
 * makes it a lead that can delegate:
 *   - `--additional-mcp-config @<file>` hands it Kumo's worker bridge for this
 *     run only. The file sits under the Kumo state directory, owner-only and
 *     removed when the client stops — it holds the session token, which must
 *     not reach argv — and nothing is written into the user's workspace or
 *     their Copilot config;
 *   - the lead's own permissions follow the session's safety mode. A headless
 *     run denies any tool that needs approval, so autonomous mode passes
 *     `--allow-all-tools`. Any other mode allows only the bridge's server and
 *     denies the shell and file writes outright (a denial beats an allowance
 *     and anything the user has saved), and `COPILOT_ALLOW_ALL`, which would
 *     allow everything, is kept out of the run's environment. Writing then goes
 *     through the workers, which Kumo holds to the tier;
 *   - `--output-format json` prints one JSON event per line: the answer as it
 *     is written, each tool call, and the session's id. The event names follow
 *     Copilot's SDK (`assistant.message_delta`, `tool.execution_start`, …);
 *     lines that are not recognised are skipped, and a line that is not JSON at
 *     all is shown as text, so an older CLI still answers;
 *   - `--resume=<id>` keeps one conversation once the events have named it.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GenericAppClient } from "./generic-client.js";
import { BRIDGE_SERVER_NAME, bridgeLaunch, LineReader, parseJsonObject } from "./lead-support.js";
import { kumoHome, ensureDir, atomicWriteJson } from "../../config/paths.js";
import { bridgeEnvFrom } from "../../utils/process.js";
import { activeProviders } from "../../config/roles.js";

/** A session id safe to hand back on the command line. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/** The variable that switches Copilot to allow-all; Windows ignores the case of a name. */
const ALLOW_ALL_ENV_RE = /^COPILOT_ALLOW_ALL$/i;

/**
 * The bridge tool a tool event is about, or null for any other tool. Copilot
 * names an MCP tool `<server>-<tool>`, and may or may not say which server it
 * came from.
 *
 * @param {Record<string, any>} data
 * @returns {string | null}
 */
function bridgeToolName(data) {
  const prefixed = new RegExp(`^${BRIDGE_SERVER_NAME}[-_](.+)$`).exec(String(data.toolName || ""));
  if (data.mcpServerName === BRIDGE_SERVER_NAME) return String(data.mcpToolName || prefixed?.[1] || data.toolName || "") || null;
  return data.mcpServerName ? null : (prefixed?.[1] ?? null);
}

/**
 * A tool event as the item the rest of Kumo reads (see items.js). Only the
 * bridge's tools are worker calls; the lead's own tools and any other MCP
 * server the user has configured stay plain `toolUse` items.
 *
 * @param {string} id
 * @param {Record<string, any>} data
 * @param {string} status
 */
function toolItem(id, data, status) {
  const tool = bridgeToolName(data);
  const args = data.arguments ?? {};
  return tool
    ? { id, type: "mcpToolCall", server: BRIDGE_SERVER_NAME, tool, arguments: args, status }
    : { id, type: "toolUse", name: String(data.toolName || "tool"), arguments: args, status };
}

export class CopilotAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "copilot",
      bin: options.bin || process.env.COPILOT_BIN || "gh",
    });
    this.sessionId = null;
    this.mcpConfigPath = null;
    this._resetTurnState();
  }

  async startThread(opts = {}) {
    await super.startThread(opts);
    // A new thread is a new conversation.
    this.sessionId = null;
    this._removeMcpConfig();
    return { ok: true };
  }

  /**
   * Continue an earlier conversation: the next turn runs with `--resume`.
   *
   * @param {{ threadId: string, workspace?: string, model?: string, reasoningEffort?: string }} opts
   */
  async resumeThread(opts) {
    if (!SESSION_ID_RE.test(String(opts.threadId || ""))) {
      throw new Error(`'${opts.threadId}' is not a Copilot session id`);
    }
    await super.startThread(opts);
    this.sessionId = opts.threadId;
    this._removeMcpConfig();
    return { ok: true, threadId: this.sessionId, resumed: true };
  }

  /** The id of a conversation the CLI named and that can be resumed, or null. */
  currentThreadId() {
    return this.sessionId;
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
    const file = path.join(dir, `copilot-mcp-${process.pid}-${randomUUID()}.json`);
    const bridge = bridgeLaunch({ workspace: this.workspace, env: this.options.env });
    atomicWriteJson(file, {
      mcpServers: {
        [BRIDGE_SERVER_NAME]: { type: "local", command: bridge.command, args: bridge.args, env: bridge.env, tools: ["*"] },
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

  /** Whether the lead's own tools run unasked; see the file header. Only the exact mode lifts the gate. */
  _autonomous() {
    return this.options.safetyMode === "autonomous";
  }

  buildTurn(prompt, { model } = {}) {
    this._resetTurnState();
    // Flags first, prompt last. `gh copilot` has no effort flag; effort stays a no-op.
    const args = [
      "copilot",
      "--additional-mcp-config", `@${this._mcpConfigFile()}`,
      // The `=` form, one entry each: these options can take several values, and
      // a separate one could swallow the arguments after it.
      ...(this._autonomous()
        ? ["--allow-all-tools"]
        : [`--allow-tool=${BRIDGE_SERVER_NAME}`, "--deny-tool=shell", "--deny-tool=write"]),
      "--output-format", "json",
    ];
    if (model) {
      args.push("--model", model);
    }
    if (this.sessionId) {
      args.push(`--resume=${this.sessionId}`);
    }
    // `gh copilot` has no documented stdin prompt form, so the prompt stays in argv.
    args.push("-p", prompt);
    return { args };
  }

  /**
   * The CLI is given the keys of the worker providers the session assigns, as
   * the bridge it starts may need them — never in the MCP config file, which
   * sits on disk. Outside autonomous mode `COPILOT_ALLOW_ALL` is removed
   * whoever set it, so it is the last word and no `extra` can bring it back.
   */
  childEnv(extra = {}) {
    const providers = this.options.config ? activeProviders(this.options.config) : [];
    /** @type {Record<string, string|undefined>} */
    const env = { ...bridgeEnvFrom(process.env, providers), ...this.options.env, ...extra };
    if (!this._autonomous()) {
      for (const name of [...Object.keys(process.env), ...Object.keys(env)]) {
        if (ALLOW_ALL_ENV_RE.test(name)) env[name] = undefined;
      }
    }
    return super.childEnv(env);
  }

  _resetTurnState() {
    this._lines = new LineReader((line) => this._handleLine(line));
    this._tools = new Map();
    this._streamed = new Set();
    this._textMessageId = null;
    this._emittedText = false;
    this._turnSessionId = null;
    this._exitCode = null;
    this._error = null;
  }

  onStdout(text) {
    this._lines.push(text);
  }

  _handleLine(line) {
    const event = parseJsonObject(line);
    if (!event) {
      // Not JSON (an older CLI, or a diagnostic line): show it as is.
      this._emitText(null, `${line}\n`);
      return;
    }
    this._handleEvent(event);
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

  _handleEvent(event) {
    const data = event.data && typeof event.data === "object" ? event.data : {};
    for (const candidate of [event.sessionId, data.sessionId, event.session_id]) {
      if (typeof candidate === "string" && SESSION_ID_RE.test(candidate)) this._turnSessionId = candidate;
    }

    switch (event.type) {
      case "assistant.message_delta":
        this._streamed.add(data.messageId || "");
        if (typeof data.deltaContent === "string") this._emitText(data.messageId || null, data.deltaContent);
        break;
      case "assistant.message":
        // Whole when no deltas arrived for it; otherwise the deltas were the text.
        if (!this._streamed.has(data.messageId || "") && typeof data.content === "string") {
          this._emitText(data.messageId || null, data.content);
        }
        break;
      case "assistant.reasoning_delta":
        this._streamed.add(`reasoning:${data.reasoningId || ""}`);
        if (typeof data.deltaContent === "string" && data.deltaContent) this.emit("reasoning", data.deltaContent);
        break;
      case "assistant.reasoning":
        if (!this._streamed.has(`reasoning:${data.reasoningId || ""}`) && typeof data.content === "string" && data.content) {
          this.emit("reasoning", data.content);
        }
        break;
      case "tool.execution_start": {
        const id = String(data.toolCallId || randomUUID());
        this._tools.set(id, data);
        this.emit("item_started", { item: toolItem(id, data, "inProgress") });
        break;
      }
      case "tool.execution_complete": {
        const id = String(data.toolCallId || "");
        const started = this._tools.get(id);
        if (!started) break;
        this._tools.delete(id);
        const failed = data.success === false || Boolean(data.error);
        this.emit("item_completed", { item: toolItem(id, started, failed ? "failed" : "completed") });
        break;
      }
      case "result":
        if (typeof event.exitCode === "number") this._exitCode = event.exitCode;
        break;
      case "error":
      case "session.error":
        this._error = String(data.message || event.message || "") || this._error;
        break;
      default:
        break;
    }
  }

  turnResult(code, stderrTail) {
    // Only the current process owns the buffer: a stale close leaves the next turn's partial line alone.
    if (!this.proc) this._lines.flush();
    // The run's own report of how it ended covers a shim that exits 0 regardless.
    const exit = code === 0 && this._exitCode ? this._exitCode : code;
    return super.turnResult(exit, stderrTail.trim() ? stderrTail : this._error || "");
  }

  afterTurn(ok) {
    // An id from a failed first turn may name a session that was never saved.
    if (ok && this._turnSessionId) this.sessionId = this._turnSessionId;
  }

  async stop() {
    await super.stop();
    this._removeMcpConfig();
  }
}
