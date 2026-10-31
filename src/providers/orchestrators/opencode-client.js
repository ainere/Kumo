/**
 * opencode-client.js — Orchestrator client adapter for OpenCode CLI (`opencode`).
 *
 * Each turn is one `opencode run` of the official CLI, on the user's own
 * OpenCode setup. What makes it a lead that can delegate:
 *   - `OPENCODE_CONFIG_CONTENT` is opencode's inline config for one run, layered
 *     over the user's own. It names Kumo's worker bridge as a local MCP server
 *     (its tools appear as `kumo-bridge_<tool>`), so no file is written into the
 *     workspace or the user's home — and the session token the bridge needs
 *     lives in this process's environment only, never on disk or in argv;
 *   - the lead's own permissions follow the session's safety mode. Autonomous
 *     runs with `--auto`, which approves every request a non-interactive run
 *     would reject. Any other mode runs without it, so such a request is
 *     rejected, and the inline config also leaves the lead only reading and the
 *     bridge's tools: it cannot edit, run commands, start subagents or fetch,
 *     whatever the user's or the repository's own config allows. The rules sit
 *     on the `build` agent, so the run names it (`--agent build`) rather than
 *     trust a repository's `default_agent`. Writing then goes through the
 *     workers, which Kumo holds to the tier;
 *   - `--format json` prints one JSON event per line: the answer, reasoning and
 *     each tool call. Lines that are not JSON are shown as text;
 *   - `--session <id>` keeps one conversation, the id taken from the events.
 * The prompt goes over stdin, which `run` appends to its (empty) message: it
 * may span lines and be long, which a Windows .cmd shim cannot carry in argv.
 * OpenCode has no documented reasoning-effort flag, so effort stays a no-op.
 */

import { GenericAppClient } from "./generic-client.js";
import { BRIDGE_SERVER_NAME, bridgeLaunch, LineReader, parseJsonObject } from "./lead-support.js";
import { opencodeConfigContent, opencodePermissionPatch } from "../workers/opencode.js";
import { bridgeEnvFrom } from "../../utils/process.js";
import { activeProviders } from "../../config/roles.js";

/** A session id safe to hand back on the command line (OpenCode's look like `ses_…`). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * What the lead may do outside autonomous mode: read, and call the bridge's
 * tools. The last matching rule wins, so the catch-all denial comes first. The
 * tools that act are denied by name as well: a repository's own `bash: allow`
 * could otherwise keep its place after the catch-all when OpenCode layers its
 * configs, and a named rule replaces it wherever it sits.
 */
const GATED_PERMISSIONS = {
  "*": "deny",
  edit: "deny",
  bash: "deny",
  task: "deny",
  webfetch: "deny",
  websearch: "deny",
  external_directory: "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  [`${BRIDGE_SERVER_NAME}_*`]: "allow",
};

/**
 * A tool part as the item the rest of Kumo reads (see items.js). OpenCode names
 * an MCP tool `<server>_<tool>`; only the bridge's tools are worker calls, the
 * lead's own (read, bash, …) and any other server the user has configured stay
 * plain `toolUse` items.
 *
 * @param {Record<string, any>} part
 * @param {string} status
 */
function toolItem(part, status) {
  const name = String(part.tool || "tool");
  const args = part.state?.input ?? {};
  const prefix = `${BRIDGE_SERVER_NAME}_`;
  return name.startsWith(prefix) && name.length > prefix.length
    ? { id: part.callID || part.id, type: "mcpToolCall", server: BRIDGE_SERVER_NAME, tool: name.slice(prefix.length), arguments: args, status }
    : { id: part.callID || part.id, type: "toolUse", name, arguments: args, status };
}

/** A readable reason from an `error` event's payload. */
function describeError(error) {
  if (!error) return "OpenCode reported an error";
  if (typeof error === "string") return error;
  return String(error.data?.message || error.message || error.name || "OpenCode reported an error");
}

export class OpenCodeAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "opencode",
      bin: options.bin || process.env.OPENCODE_BIN || "opencode",
    });
    this.sessionId = null;
    this._resetTurnState();
  }

  async startThread(opts = {}) {
    await super.startThread(opts);
    // A new thread is a new conversation.
    this.sessionId = null;
    return { ok: true };
  }

  /**
   * Continue an earlier conversation: the next turn runs with `--session`.
   *
   * @param {{ threadId: string, workspace?: string, model?: string, reasoningEffort?: string }} opts
   */
  async resumeThread(opts) {
    if (!SESSION_ID_RE.test(String(opts.threadId || ""))) {
      throw new Error(`'${opts.threadId}' is not an OpenCode session id`);
    }
    await super.startThread(opts);
    this.sessionId = opts.threadId;
    return { ok: true, threadId: this.sessionId, resumed: true };
  }

  /** The id of a session the CLI named and that can be resumed, or null. */
  currentThreadId() {
    return this.sessionId;
  }

  /**
   * The inline config naming the bridge for this workspace. The bridge's
   * environment (engine endpoint, session token, worker providers' keys) is in
   * it, and so only in the environment of the run it is passed to.
   *
   * @returns {string}
   */
  _configContent() {
    const providers = this.options.config ? activeProviders(this.options.config) : [];
    const bridge = bridgeLaunch({
      workspace: this.workspace,
      env: { ...bridgeEnvFrom(process.env, providers), ...this.options.env },
    });
    return opencodeConfigContent({
      // Only the exact mode lifts the gate: a missing or misspelled one stays gated.
      ...(this._autonomous() ? {} : opencodePermissionPatch(GATED_PERMISSIONS)),
      mcp: {
        [BRIDGE_SERVER_NAME]: {
          type: "local",
          command: [bridge.command, ...bridge.args],
          // Blanked: OpenCode starts the bridge with its own environment underneath this
          // one, and this config (the token, the workers' keys, the lead's denials) must
          // not reach the bridge's workers, nor an OpenCode write worker its `edit: deny`.
          environment: { ...bridge.env, OPENCODE_CONFIG_CONTENT: "" },
          enabled: true,
        },
      },
    });
  }

  /** Whether the lead's own tools run unasked; see the file header. */
  _autonomous() {
    return this.options.safetyMode === "autonomous";
  }

  buildTurn(prompt, { model } = {}) {
    this._resetTurnState();
    const args = ["run", "--format", "json"];
    if (this._autonomous()) args.push("--auto");
    // The gate's rules sit on `build` and globally; a repository whose opencode.json
    // sets another `default_agent` would otherwise run the lead outside them.
    else args.push("--agent", "build");
    if (model) {
      args.push("--model", model);
    }
    if (this.sessionId) {
      args.push("--session", this.sessionId);
    }
    return { args, stdin: prompt, env: { OPENCODE_CONFIG_CONTENT: this._configContent() } };
  }

  _resetTurnState() {
    this._lines = new LineReader((line) => this._handleLine(line));
    this._tools = new Set();
    this._textMessageId = null;
    this._emittedText = false;
    this._failure = null;
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
    if (typeof event.sessionID === "string" && SESSION_ID_RE.test(event.sessionID)) {
      this.sessionId = event.sessionID;
    }
    const part = event.part && typeof event.part === "object" ? event.part : {};

    switch (event.type) {
      case "text":
        if (typeof part.text === "string") this._emitText(part.messageID || null, part.text);
        break;
      case "reasoning":
        if (typeof part.text === "string" && part.text) this.emit("reasoning", part.text);
        break;
      case "tool_use":
        this._handleToolUse(part);
        break;
      case "error":
        this._failure = describeError(event.error);
        break;
      default:
        // step_start / step_finish carry token counts only; the turn ends when the process does.
        break;
    }
  }

  /**
   * A tool part reports its state: older CLIs print it once it has finished,
   * newer ones as it starts and again when it ends. Either way the call is
   * started once and completed once.
   */
  _handleToolUse(part) {
    const status = part.state?.status;
    const id = part.callID || part.id;
    if (!id) return;
    if (!this._tools.has(id)) {
      this._tools.add(id);
      this.emit("item_started", { item: toolItem(part, "inProgress") });
    }
    if (status === "completed" || status === "error") {
      this._tools.delete(id);
      this.emit("item_completed", { item: toolItem(part, status === "error" ? "failed" : "completed") });
    }
  }

  turnResult(code, stderrTail) {
    // Only the current process owns the buffer: a stale close leaves the next turn's partial line alone.
    if (!this.proc) this._lines.flush();
    // OpenCode can report a session error and still exit 0.
    if (this._failure) return { ok: false, reason: this._failure };
    return super.turnResult(code, stderrTail);
  }
}
