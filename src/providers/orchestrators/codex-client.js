/**
 * codex-client.js — Headless JSON-RPC client for Codex app-server.
 *
 * Communicates with `codex app-server --stdio` in the background,
 * keeping the parent terminal completely clean while providing streaming deltas,
 * live rate limit snapshots, and tool event notifications.
 *
 * Message shapes follow the app-server protocol as published by
 * `codex app-server generate-json-schema` (codex-cli 0.153).
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCodexBinary } from "./codex.js";
import { isToolCallItem } from "./items.js";
import { formatPlanType, formatResetTime } from "../../utils/ui.js";
import { safeSpawn, stopProcessTree } from "../../utils/process.js";
import { VERSION } from "../../version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path of the bridge server shipped with this installation. */
const BRIDGE_SCRIPT = path.resolve(__dirname, "../../bridge/server.js");

/**
 * Server→client requests that ask a human to approve something, with the
 * result that grants the request.
 */
const APPROVE_RESULTS = {
  "item/commandExecution/requestApproval": { decision: "accept" },
  "item/fileChange/requestApproval": { decision: "accept" },
  applyPatchApproval: { decision: "approved" },
  execCommandApproval: { decision: "approved" },
};

/**
 * The answer Kumo gives a server→client request nobody is there to handle.
 * Each one is the protocol's "no" — the agent carries on without the action.
 * An unanswered request would instead stall the turn until it timed out.
 */
export const SERVER_REQUEST_DEFAULTS = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { permissions: {} },
  "mcpServer/elicitation/request": { action: "decline" },
  "item/tool/requestUserInput": { answers: {} },
  applyPatchApproval: { decision: "denied" },
  execCommandApproval: { decision: "denied" },
};

/** The MCP server name Kumo registers its worker bridge under. */
export const BRIDGE_SERVER_NAME = "kumo-bridge";

/**
 * Variables (besides every `KUMO_*` one) the bridge needs from the session:
 * provider binary overrides, endpoint overrides, and the direct-API keys.
 */
const BRIDGE_ENV_NAMES = new Set([
  "AGY_BIN",
  "GEMINI_BIN",
  "CODEX_BIN",
  "CLAUDE_BIN",
  "OLLAMA_BIN",
  "COPILOT_BIN",
  "CURSOR_BIN",
  "OPENCODE_BIN",
  "COMMANDCODE_BIN",
  "GEMINI_TIMEOUT_MS",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "GEMINI_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "COMPAT_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "COMPAT_API_KEY",
]);

/**
 * Names of the session variables to forward to the bridge.
 *
 * Codex starts MCP servers with a filtered environment — verified against
 * codex-cli 0.153: an inherited variable does not arrive, one listed in
 * `env_vars` does. Without this the bridge never saw KUMO_HOME,
 * KUMO_SAFETY_MODE or KUMO_INTERACTIVE_APPROVAL (so `interactive` silently
 * became `diff-review`), nor the API keys of a direct-API worker. Forwarding by
 * name keeps secret values out of the thread config Codex records.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string[]}
 */
export function bridgeEnvVarNames(env) {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && (k.startsWith("KUMO_") || BRIDGE_ENV_NAMES.has(k)))
    .sort();
}

/** The elicitation answer that allows an MCP tool call. */
const ALLOW_TOOL_CALL = { action: "accept", content: {} };

/**
 * Whether a server request is Codex asking to allow an MCP tool call. Codex
 * phrases those as `mcpServer/elicitation/request` tagged
 * `_meta.codex_approval_kind: "mcp_tool_call"` — for every MCP server,
 * Kumo's own bridge included.
 *
 * @param {string} method
 * @param {Record<string, any>} params
 */
function isMcpToolApproval(method, params) {
  return method === "mcpServer/elicitation/request" && params?._meta?.codex_approval_kind === "mcp_tool_call";
}

/**
 * One-paragraph description of a server request, for an approval prompt.
 *
 * @param {string} method
 * @param {Record<string, any>} params
 * @returns {string}
 */
export function describeServerRequest(method, params = {}) {
  const lines = [];
  const command = Array.isArray(params.command) ? params.command.join(" ") : params.command;
  if (command) lines.push(`Command: ${command}`);
  if (params.cwd) lines.push(`In: ${params.cwd}`);
  if (params.fileChanges && typeof params.fileChanges === "object") {
    lines.push(`Files: ${Object.keys(params.fileChanges).join(", ")}`);
  }
  if (params.grantRoot) lines.push(`Requests write access to: ${params.grantRoot}`);
  if (params.reason) lines.push(`Reason: ${params.reason}`);
  if (params.message) lines.push(String(params.message));
  const toolParams = params._meta?.tool_params_display;
  if (Array.isArray(toolParams)) {
    for (const p of toolParams) lines.push(`  ${p.display_name || p.name}: ${p.value}`);
  }
  return lines.length > 0 ? lines.join("\n") : `Codex request: ${method}`;
}

function getTaskSignature(item) {
  if (!item) return "";
  const raw = item.arguments || item.input || item.tool_input || item.args || item.task;
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

export class CodexAppClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bin = options.bin || findCodexBinary();
    this.proc = null;
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.buffer = "";
    this.threadId = null;
    this.activeTurnId = null;
    this.rateLimits = null;
    this._pendingItemIds = new Map();
    // Latest kumo-bridge startup state per thread, from mcpServer/startupStatus/updated.
    this._bridgeStatus = new Map();
    this._bridgeChecked = new Set();
  }

  /**
   * Start the background `codex app-server --stdio` process.
   */
  async start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const succeed = (res) => {
        if (settled) return;
        settled = true;
        this.emit("initialized", res);
        resolve(res);
      };

      try {
        this.proc = safeSpawn(this.bin, ["app-server", "--stdio"], {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            ...this.options.env,
          },
        });
      } catch (err) {
        return reject(new Error(`Failed to spawn Codex app-server at '${this.bin}': ${err.message}`));
      }

      const proc = this.proc;
      proc.stdout.on("data", (chunk) => this._handleStdout(chunk));
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        // Emit for debug if needed, but don't pollute terminal
        this.emit("stderr", text);
      });

      proc.on("error", (err) => {
        // A bare emit("error") with no listener throws and takes the whole
        // process down; callers learn about the failure from the rejection.
        if (this.listenerCount("error") > 0) this.emit("error", err);
        this._rejectPending(err);
        fail(new Error(`Failed to spawn Codex app-server at '${this.bin}': ${err.message}`));
      });

      proc.on("close", (code) => {
        if (this.proc === proc) this.proc = null;
        this.emit("close", code);
        // Anything still in flight can never be answered now; without this each
        // caller waits out the full 30s request timeout.
        this._rejectPending(new Error(`Codex app-server exited (code ${code})`));
        fail(new Error(`Codex app-server exited before initialization (code ${code})`));
      });

      // Send initialize handshake
      this.request("initialize", {
        clientInfo: { name: "kumo", version: VERSION },
        capabilities: {},
      })
        .then(succeed)
        .catch(fail);
    });
  }

  /**
   * Reject every in-flight JSON-RPC request.
   *
   * @param {Error} err
   */
  _rejectPending(err) {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(id);
      try {
        pending.reject(err);
      } catch {
        /* the caller already went away */
      }
    }
  }

  /** Write one JSON-RPC message, if the server is still listening. */
  _send(message) {
    if (!this.proc || !this.proc.stdin.writable) return false;
    this.proc.stdin.write(JSON.stringify(message) + "\n");
    return true;
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method, params = {}) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("Codex app-server is not running or stdin is closed.");
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex JSON-RPC request '${method}' (id ${id}) timed out after 30s`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Send a JSON-RPC notification (no reply expected).
   */
  notify(method, params = {}) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  /**
   * Query current account rate limits and parse into a normalized status object.
   */
  async getRateLimits() {
    const res = await this.request("account/rateLimits/read");
    const snapshot = res?.rateLimits || {};
    const primary = snapshot.primary || null;
    const secondary = snapshot.secondary || null;
    const planType = snapshot.planType || null;
    const credits = res?.rateLimitResetCredits || null;

    const normalized = {
      raw: res,
      planType: formatPlanType(planType),
      rawPlan: planType,
      usedPercent: primary?.usedPercent ?? 0,
      remainingPercent: Math.max(0, 100 - (primary?.usedPercent ?? 0)),
      resetsAt: primary?.resetsAt ?? null,
      resetFormatted: formatResetTime(primary?.resetsAt),
      windowMinutes: primary?.windowDurationMins ?? null,
      creditsAvailable: credits?.availableCount ?? 0,
      credits: credits?.credits ?? [],
      secondary: secondary
        ? {
            usedPercent: secondary.usedPercent,
            resetsAt: secondary.resetsAt,
            resetFormatted: formatResetTime(secondary.resetsAt),
          }
        : null,
    };

    this.rateLimits = normalized;
    return normalized;
  }

  /**
   * Initialize a thread with workspace, model, reasoning effort, and Worker MCP server.
   *
   * The bridge is handed to Codex as a per-thread config override, so nothing
   * is written into the user's repository. It deliberately gets no `--model` or
   * `--effort`: it reads the worker settings from config on every call, which
   * is what lets `/model worker` take effect without restarting the thread.
   */
  async startThread(opts = {}) {
    const { model, payload } = this._threadPayload(opts);
    if (model) await this._warnIfModelUnavailable(model);
    const res = await this.request("thread/start", payload);
    this.threadId = res?.thread?.id || res?.threadId;
    return this.threadId;
  }

  /**
   * Continue an earlier thread (`thread/resume`): Codex reloads it from disk
   * with its history, under the same bridge and model overrides a new thread
   * gets. Only threads that ran a turn are on disk.
   *
   * @param {{ threadId: string, workspace?: string, model?: string, reasoningEffort?: string }} opts
   */
  async resumeThread(opts) {
    const { model, payload } = this._threadPayload(opts);
    if (model) await this._warnIfModelUnavailable(model);
    // The history is already in the thread; Kumo does not render it.
    const res = await this.request("thread/resume", { ...payload, threadId: opts.threadId, excludeTurns: true });
    this.threadId = res?.thread?.id || opts.threadId;
    return this.threadId;
  }

  /** The current thread's id, which `resumeThread` accepts later. */
  currentThreadId() {
    return this.threadId;
  }

  /**
   * A model switch needs no new thread: every turn names its model and effort
   * (`turn/start` accepts both), so the conversation carries on. Only the
   * availability check runs again.
   *
   * @param {{ model?: string }} opts
   */
  async applyModel({ model } = {}) {
    if (model) await this._warnIfModelUnavailable(model);
  }

  /**
   * The `thread/start` / `thread/resume` parameters for a workspace.
   *
   * @param {{ workspace?: string, model?: string, reasoningEffort?: string, workerModel?: string, workerEffort?: string }} opts
   */
  _threadPayload(opts = {}) {
    const workspace = path.resolve(opts.workspace || process.cwd());
    const model = opts.model || null;
    const effort = opts.reasoningEffort || null;
    this.workerModel = opts.workerModel || null;
    this.workerEffort = opts.workerEffort || null;

    const config = {
      mcp_servers: {
        [BRIDGE_SERVER_NAME]: {
          command: process.execPath,
          args: [BRIDGE_SCRIPT, "--workspace", workspace],
          env_vars: bridgeEnvVarNames({ ...process.env, ...this.options.env }),
        },
      },
    };
    if (model) config.model = model;
    if (effort) config.model_reasoning_effort = effort;

    const payload = { cwd: workspace, config };
    if (model) payload.model = model;
    return { workspace, model, payload };
  }

  /**
   * Models this Codex account can use, from `model/list` (cached per client).
   * Returns null when the server cannot say.
   *
   * @returns {Promise<Array<{ id: string, isDefault?: boolean }>|null>}
   */
  async listModels() {
    if (this._models !== undefined) return this._models;
    try {
      const res = await this.request("model/list", {});
      this._models = Array.isArray(res?.data) && res.data.length > 0 ? res.data : null;
    } catch {
      this._models = null;
    }
    return this._models;
  }

  /**
   * Warn — without blocking — when the configured model is not offered to this
   * account. Codex only rejects it at the first turn, with a terse
   * `model_not_found`; naming the available ids up front says how to fix it.
   *
   * @param {string} model
   */
  async _warnIfModelUnavailable(model) {
    const models = await this.listModels();
    if (!models || models.some((m) => m.id === model)) return;
    const available = models.map((m) => (m.isDefault ? `${m.id} (default)` : m.id)).join(", ");
    this.emit("warning", {
      message:
        `Model '${model}' is not available on this Codex account (available: ${available}). ` +
        `Switch with: kumo model orchestrator <model>`,
    });
  }

  /**
   * Wait until the bridge MCP server of the current thread has finished
   * starting. Codex starts MCP servers asynchronously and fixes a turn's tool
   * list when the turn begins; a turn sent while the bridge is still
   * `starting` has no worker tools, and the model reports it cannot delegate.
   *
   * @param {number} [timeoutMs]
   */
  async _waitForBridge(timeoutMs = 20000) {
    // Once per thread: the bridge's state only matters for the first turn, and
    // a Codex that never reports it must not cost every turn the full wait.
    if (this._bridgeChecked.has(this.threadId)) return;
    this._bridgeChecked.add(this.threadId);

    const settled = () => {
      const s = this._bridgeStatus.get(this.threadId)?.status;
      return Boolean(s && s !== "starting");
    };
    if (!settled()) {
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.off("bridge_status", onStatus);
          resolve();
        };
        const onStatus = () => {
          if (settled()) finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        this.on("bridge_status", onStatus);
      });
    }
    const status = this._bridgeStatus.get(this.threadId);
    if (!status || status.status === "starting") {
      this.emit("warning", {
        message: `kumo-bridge was not ready after ${Math.round(timeoutMs / 1000)}s; worker tools may be missing this turn.`,
      });
    } else if (status.status !== "ready") {
      this.emit("warning", {
        message: `kumo-bridge ${status.status}: ${status.error || status.failureReason || "no reason given"}. Worker tools are unavailable.`,
      });
    }
  }

  /**
   * Start a new turn with the user prompt. Resolves once Codex accepted the
   * turn; its end arrives later as `turn_completed`.
   */
  async startTurn(prompt, opts = {}) {
    if (!this.threadId) {
      throw new Error("No active thread. Call startThread() first.");
    }
    await this._waitForBridge();

    const params = {
      threadId: this.threadId,
      input: [
        {
          type: "text",
          text: prompt,
          text_elements: [],
        },
      ],
    };

    if (opts.model) params.model = opts.model;
    if (opts.effort) params.effort = opts.effort;

    this._interruptPending = false;
    this._awaitingTurnId = true;
    // Unknown until Codex answers; the new turn's first events may arrive
    // before the response and must not be filtered against the previous id.
    this.activeTurnId = null;
    try {
      const res = await this.request("turn/start", params);
      this.activeTurnId = res?.turn?.id || res?.turnId;
    } finally {
      this._awaitingTurnId = false;
    }
    // Ctrl+C before Codex named the turn: send the interrupt now that we can.
    if (this._interruptPending) {
      this._interruptPending = false;
      await this.interruptTurn();
    }
    return { turnId: this.activeTurnId };
  }

  /**
   * Interrupt the active turn.
   */
  async interruptTurn() {
    if (this._awaitingTurnId) {
      // turn/start has been sent but its id is not known yet; dropping the
      // request here let the turn run on and stream into the next one.
      this._interruptPending = true;
      return;
    }
    if (!this.threadId || !this.activeTurnId) return;
    try {
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * True when a notification belongs to a turn other than the active one —
   * typically the tail of an interrupted turn arriving after the next began.
   * Notifications without a turn id, or before the active id is known, pass.
   *
   * @param {{ turnId?: string, turn?: { id?: string } }} params
   */
  _isStaleTurnEvent(params) {
    const turnId = params?.turnId || params?.turn?.id;
    return Boolean(turnId && this.activeTurnId && turnId !== this.activeTurnId);
  }

  /**
   * Handle incoming stdout data buffer from Codex.
   *
   * Three message kinds share the stream. A `method` with an `id` is a request
   * *from* the server (approvals); a `method` alone is a notification; an `id`
   * alone answers one of our requests. Checking `method` first matters: the
   * server numbers its requests independently, so their ids collide with ours.
   */
  _handleStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep partial trailing line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (typeof msg.method === "string") {
        if (msg.id !== undefined && msg.id !== null) {
          this._handleServerRequest(msg);
        } else {
          this._handleNotification(msg);
        }
        continue;
      }

      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const { resolve, reject, timeout } = this.pendingRequests.get(msg.id);
        clearTimeout(timeout);
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
      }
    }
  }

  /**
   * Route a server→client request to a `server_request` listener, or answer it
   * with the protocol's refusal when there is none. Every request gets exactly
   * one reply: Codex blocks the turn until it does.
   *
   * @param {{ id: string|number, method: string, params?: object }} msg
   */
  _handleServerRequest(msg) {
    const { id, method } = msg;
    const params = msg.params || {};
    let answered = false;
    const reply = (payload) => {
      if (answered) return;
      answered = true;
      this._send({ jsonrpc: "2.0", id, ...payload });
    };

    const toolApproval = isMcpToolApproval(method, params);
    // Codex asks before every MCP tool call, the bridge's included. Calling the
    // worker tools is the whole point of the session, and what they may do to
    // the workspace is gated inside the bridge by the safety mode — so these
    // are allowed outright. Declining them failed every delegation, and
    // leaving them unanswered (as Kumo used to) hung the turn.
    if (toolApproval && params.serverName === BRIDGE_SERVER_NAME) {
      reply({ result: ALLOW_TOOL_CALL });
      return;
    }

    const fallback = SERVER_REQUEST_DEFAULTS[method];
    const approveResult = toolApproval ? ALLOW_TOOL_CALL : APPROVE_RESULTS[method];
    const request = {
      id,
      method,
      params,
      isApproval: Boolean(approveResult),
      description: describeServerRequest(method, params),
      approve: () => (approveResult ? reply({ result: approveResult }) : request.decline()),
      decline: () =>
        fallback
          ? reply({ result: fallback })
          : reply({ error: { code: -32601, message: `Kumo does not handle '${method}'` } }),
    };

    if (this.listenerCount("server_request") > 0) {
      this.emit("server_request", request);
    } else {
      request.decline();
    }
  }

  /**
   * Route server notifications to typed events.
   */
  _handleNotification(msg) {
    const method = msg.method;
    const params = msg.params || {};

    if (process.env.KUMO_DEBUG) {
      console.error(`[KUMO_DEBUG] codex-client notification (${method}):`, JSON.stringify(params));
    }

    this.emit("notification", msg);

    // An interrupted turn can keep streaming, and complete, after the next
    // turn has started; its events must not be mistaken for the new turn's.
    if (this._isStaleTurnEvent(params)) return;

    switch (method) {
      case "item/agentMessage/delta":
        // Assistant text delta
        this.emit("delta", params.delta || "");
        break;

      case "item/reasoning/delta":
        // Reasoning text delta
        this.emit("reasoning", params.delta || "");
        break;

      case "item/started": {
        if (!params.item) params.item = {};
        const item = params.item;
        let itemId = item.id || item.callId || item.call_id;
        if (isToolCallItem(item) && !item.name && item.tool) item.name = item.tool;
        const key = item.name || item.tool || item.type || "item";
        const signature = getTaskSignature(item);

        if (!itemId) {
          itemId = randomUUID();
          item.id = itemId;
        }

        if (!this._pendingItemIds.has(key)) {
          this._pendingItemIds.set(key, []);
        }
        this._pendingItemIds.get(key).push({
          id: itemId,
          signature,
          timestamp: Date.now(),
        });

        if (isToolCallItem(item)) {
          if (!item.model && this.workerModel) item.model = this.workerModel;
          if (!item.effort && this.workerEffort) item.effort = this.workerEffort;
        }
        this.emit("item_started", params);
        break;
      }

      case "item/completed": {
        if (!params.item) params.item = {};
        const item = params.item;
        let itemId = item.id || item.callId || item.call_id;
        if (isToolCallItem(item) && !item.name && item.tool) item.name = item.tool;
        const key = item.name || item.tool || item.type || "item";
        const queue = this._pendingItemIds.get(key) || [];
        const signature = getTaskSignature(item);

        if (itemId) {
          // Direct ID provided — clean up matching pending record if present
          const idx = queue.findIndex((entry) => entry.id === itemId);
          if (idx !== -1) queue.splice(idx, 1);
          item.id = itemId;
        } else {
          // Synthetic fallback path: match by signature first, then FIFO fallback
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
          itemId = matched ? matched.id : randomUUID();
          item.id = itemId;
        }

        this.emit("item_completed", params);
        break;
      }

      case "turn/completed": {
        this.activeTurnId = null;
        const status = params.turn?.status || "completed";
        const ok = status === "completed";
        this.emit("turn_completed", {
          ...params,
          ok,
          status,
          reason: ok ? undefined : params.turn?.error?.message || `turn ${status}`,
        });
        break;
      }

      case "account/rateLimits/updated":
        this.emit("rate_limits", params);
        break;

      case "mcpServer/startupStatus/updated":
        if (params.name === BRIDGE_SERVER_NAME) {
          this._bridgeStatus.set(params.threadId, params);
          this.emit("bridge_status", params);
        }
        break;

      case "error": {
        const message = params.error?.message || params.message || "Codex reported an error";
        // Codex retries transient failures itself; only a final error ends the turn.
        if (params.willRetry) {
          this.emit("warning", { ...params, message });
        } else {
          this.emit("server_error", { ...params, message });
        }
        break;
      }
    }
  }

  /**
   * Terminate the client and background process cleanly.
   */
  async stop() {
    if (this.proc) {
      stopProcessTree(this.proc);
      this.proc = null;
    }
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error("Codex client stopped"));
    }
    this.pendingRequests.clear();
  }
}
