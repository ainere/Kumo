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

// @ts-check
/**
 * session.js — One conversation with an orchestrator, in one workspace.
 *
 * A Session owns everything the REPL used to keep in its closure: the
 * orchestrator client and its lifecycle, the running turn, the worker calls
 * in flight and their output, approvals, the chat record and its provider
 * thread, quotas, and the settings this session runs with. It reports all of
 * it as typed events (events.js) and takes commands as methods, so the CLI
 * and the desktop app drive the same object.
 *
 *   const session = new Session({ workspace, interactive: true });
 *   session.on("event", render);
 *   await session.start();
 *   const outcome = await session.send("fix the failing test");
 */

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { loadConfig, setConfigValue } from "../config/settings.js";
import { syncAgentConfigs } from "../config/sync.js";
import { createOrchestratorClient, orchestratorDelegates } from "../providers/orchestrators/registry.js";
import { isToolCallItem, toolNameOf, toolArgsOf } from "../providers/orchestrators/items.js";
import { emptyRoles, roleForTool, resolveRoleTarget, roleToolSignature } from "../config/roles.js";
import { runTurn } from "../providers/orchestrators/turn-wait.js";
import * as defaultStore from "../data/sessions.js";
import { makeEvent } from "./events.js";
import { snapshotSettings, applySettingsPatch } from "./settings.js";
import { ToolTracker } from "./tool-tracker.js";
import { LiveLogTailer } from "./live-log-tailer.js";
import { QuotaMonitor } from "./quota-monitor.js";
import { EngineIpcServer } from "./ipc/engine-server.js";
import { ENGINE_ENDPOINT_ENV, SESSION_TOKEN_ENV } from "./ipc/protocol.js";

/** @typedef {import("./events.js").SessionSettings} SessionSettings */
/** @typedef {import("./events.js").KumoEvent} KumoEvent */
/** @typedef {import("./events.js").EventType} EventType */
/**
 * @typedef {{
 *   ok: boolean,
 *   reason?: string,
 *   text: string,
 *   elapsedMs: number,
 *   interrupted: boolean,
 *   timedOut: boolean,
 * }} TurnOutcome
 * @typedef {{
 *   workspace: string,
 *   settings?: SessionSettings,
 *   chatId?: string | null,
 *   persist?: boolean,
 *   interactive?: boolean,
 *   ipc?: boolean,
 *   quotas?: boolean,
 *   createClient?: (opts: any) => any,
 *   store?: typeof defaultStore,
 *   id?: string,
 * }} SessionOptions
 */

/** How often the fallback approval watcher looks for bridge request files. */
const APPROVAL_POLL_MS = 500;

export class Session extends EventEmitter {
  /** @param {SessionOptions} opts */
  constructor(opts) {
    super();
    this.id = opts.id || randomUUID();
    this.workspace = path.resolve(opts.workspace);
    /** @type {SessionSettings} */
    this.settings = opts.settings
      ? // Settings from before roles existed have none: every role on the shared worker.
        { ...opts.settings, roles: opts.settings.roles ? structuredClone(opts.settings.roles) : emptyRoles() }
      : snapshotSettings(loadConfig());
    this.persist = opts.persist !== false;
    this.interactive = Boolean(opts.interactive);
    this.useIpc = opts.ipc !== false;
    this.createClient = opts.createClient || createOrchestratorClient;
    this.store = opts.store || defaultStore;
    /** @type {string|null} */
    this.chatId = opts.chatId || null;
    this.turnCount = 0;
    /** @type {any} */
    this.client = null;
    this.needsReconnect = false;
    this.busy = false;
    this.closed = false;
    /** @type {{ done: Promise<any>, interrupt: (reason?: string) => void } | null} */
    this.activeTurn = null;
    /** @type {{ id: string, transcript: string[] } | null} */
    this._turn = null;
    this.tools = new ToolTracker();
    /** @type {Map<string, LiveLogTailer>} */
    this._tailers = new Map();
    /** @type {Map<string, { kind: "write"|"orchestrator", resolve: (approved: boolean, reason?: string) => void }>} */
    this.pendingApprovals = new Map();
    /** @type {Set<string>} bridge approval files already asked about */
    this._seenApprovalFiles = new Set();
    /** @type {NodeJS.Timeout|null} */
    this._approvalTimer = null;
    /** @type {EngineIpcServer|null} */
    this.ipc = null;
    /** @type {Promise<void>|null} */
    this._ready = null;

    this.quotas = new QuotaMonitor({
      getClient: () => this.client,
      getSettings: () => this.settings,
      useCache: opts.quotas !== false,
    });
    this.quotas.on("updated", (snapshot) => this._emit("quota.updated", snapshot));
    this._runQuotas = opts.quotas !== false;
  }

  // ── events ──

  /**
   * @template {EventType} T
   * @param {T} type
   * @param {Omit<import("./events.js").EventOf<T>, "type" | "sessionId" | "at">} payload
   */
  _emit(type, payload) {
    this.emit("event", makeEvent(type, this.id, payload));
  }

  /** @param {string} message */
  _warn(message) {
    this._emit("session.warning", { message });
  }

  /** @param {string} message */
  _notice(message) {
    this._emit("session.notice", { message });
  }

  // ── lifecycle ──

  /**
   * Open the chat, the engine endpoint and the orchestrator. Safe to call
   * more than once; later calls return the same promise. A failure leaves the
   * session usable: the next `send` reconnects.
   *
   * @returns {Promise<void>}
   */
  start() {
    if (!this._ready) this._ready = this._boot();
    return this._ready;
  }

  async _boot() {
    let threadId = null;
    if (this.persist) {
      this.store.registerProject(this.workspace);
      const chat = this.chatId ? this._chatRecord(this.chatId) : null;
      if (chat) {
        this.turnCount = chat.turns || 0;
        threadId = chat.provider === this.settings.orchestratorProvider ? chat.threadId || null : null;
      } else {
        this.chatId = this._newChatRecord();
      }
    }
    if (this.useIpc) await this._openIpc();
    if (this._runQuotas) this.quotas.start();

    let resumed = false;
    try {
      resumed = await this._connect({ threadId });
    } finally {
      this._emit("session.ready", {
        workspace: this.workspace,
        chatId: this.chatId,
        resumed,
        settings: { ...this.settings },
      });
    }
    if (this._runQuotas) void this.quotas.refresh();
  }

  async _openIpc() {
    const server = new EngineIpcServer({
      hello: () => ({ sessionId: this.id, interactive: this.interactive }),
      requests: {
        "settings.get": () => ({ ...this.settings, interactive: this.interactive }),
        "approval.request": (params) => this._requestWriteApproval(params),
      },
      notifications: {
        "run.started": (params) => this._onRunStarted(params),
        "run.output": (params) => this._onRunOutput(params),
        "run.finished": () => {},
      },
    });
    try {
      await server.listen();
      this.ipc = server;
    } catch (err) {
      // Without it the bridge falls back to files; nothing else is lost.
      this._warn(`Could not open the engine endpoint (${err instanceof Error ? err.message : err}); using file-based worker updates.`);
    }
  }

  /**
   * Replace the orchestrator client and open a thread on it.
   *
   * @param {{ threadId?: string | null }} [opts]
   * @returns {Promise<boolean>} whether an earlier thread was resumed
   */
  async _connect({ threadId = null } = {}) {
    const previous = this.client;
    // Detach first: the old client's late `close` must not flag the new one.
    this.client = null;
    if (previous) {
      try {
        await previous.stop();
      } catch {}
    }
    this.needsReconnect = false;

    const provider = this.settings.orchestratorProvider;
    if (!orchestratorDelegates(provider)) {
      this._warn(`${provider} cannot call Kumo's worker tools; it answers prompts on its own.`);
    }
    this._refreshProjectConfigs();

    const client = this.createClient({
      provider,
      model: this.settings.orchestratorModel,
      effort: this.settings.reasoningEffort,
      safetyMode: this.settings.safetyMode,
      workspace: this.workspace,
      config: { ...loadConfig(), ...this.settings },
      env: this._clientEnv(),
    });
    this.client = client;
    this._attach(client);
    try {
      await client.start();
      return await this._openThread({ threadId });
    } catch (err) {
      // A client with no thread fails every later prompt with "No active
      // thread"; the next prompt retries the whole start instead.
      this.needsReconnect = true;
      throw err;
    }
  }

  /** Environment handed to the orchestrator, and through it to the bridge. */
  _clientEnv() {
    /** @type {Record<string, string>} */
    const env = { ORCHESTRATOR_WORKSPACE: this.workspace, KUMO_WORKSPACE: this.workspace };
    if (this.ipc?.endpoint) {
      env[ENGINE_ENDPOINT_ENV] = this.ipc.endpoint;
      env[SESSION_TOKEN_ENV] = this.ipc.token;
    }
    // For a bridge that cannot reach the engine: a human is there to approve
    // writes. Without it, `interactive` safety mode degrades to diff-review.
    if (this.interactive && this.settings.safetyMode === "interactive") env.KUMO_INTERACTIVE_APPROVAL = "1";
    return env;
  }

  /**
   * Resume `threadId` when the client can, else start a new thread.
   *
   * @param {{ threadId?: string | null }} opts
   * @returns {Promise<boolean>} whether the thread was resumed
   */
  async _openThread({ threadId = null }) {
    const client = this.client;
    const opts = {
      workspace: this.workspace,
      model: this.settings.orchestratorModel,
      reasoningEffort: this.settings.reasoningEffort,
    };
    if (threadId && typeof client.resumeThread === "function") {
      try {
        await client.resumeThread({ ...opts, threadId });
        return true;
      } catch (err) {
        this._warn(`Could not resume the earlier conversation (${err instanceof Error ? err.message : err}); starting a new one.`);
      }
    }
    await client.startThread(opts);
    return false;
  }

  /** @param {any} cl */
  _attach(cl) {
    const current = () => cl === this.client;

    cl.on("delta", (/** @type {string} */ text) => {
      if (!current() || !this._turn) return;
      this._turn.transcript.push(text);
      this._emit("turn.delta", { turnId: this._turn.id, text });
    });
    cl.on("reasoning", (/** @type {string} */ text) => {
      if (!current() || !this._turn) return;
      this._emit("turn.reasoning", { turnId: this._turn.id, text: text || "" });
    });
    cl.on("warning", (/** @type {any} */ w) => {
      if (current()) this._warn(String(w?.message || w));
    });
    cl.on("notice", (/** @type {any} */ text) => {
      if (current()) this._notice(String(text));
    });
    cl.on("server_request", (/** @type {any} */ req) => this._onServerRequest(cl, req));
    cl.on("item_started", (/** @type {any} */ params) => {
      if (current()) this._onToolStarted(params?.item || {});
    });
    cl.on("item_completed", (/** @type {any} */ params) => {
      if (current()) this._onToolCompleted(params?.item || {});
    });
    // During a turn, runTurn turns these into the turn's outcome; between
    // turns nothing else would report them.
    cl.on("server_error", (/** @type {any} */ err) => {
      if (current() && !this.busy) this._emit("session.error", { message: String(err?.message || JSON.stringify(err)) });
    });
    cl.on("close", (/** @type {any} */ code) => {
      if (!current()) return;
      this.needsReconnect = true;
      if (!this.busy) this._warn(`Orchestrator process exited (code ${code}); it restarts with the next prompt.`);
    });
  }

  // ── turns ──

  /**
   * Run one turn. Resolves when the orchestrator has really finished — on
   * success, failure, timeout or interrupt — never while it still works.
   *
   * @param {string} prompt
   * @returns {Promise<TurnOutcome>}
   */
  async send(prompt) {
    if (this.closed) throw new Error("This session is closed.");
    if (this.busy) throw new Error("A turn is already running.");
    this.busy = true;
    const turnId = randomUUID();
    const startedAt = Date.now();
    /** @type {string[]} */
    const transcript = [];
    this._turn = { id: turnId, transcript };
    this._emit("turn.started", { turnId, prompt });

    /** @type {{ ok: boolean, reason?: string, timedOut?: boolean, interrupted?: boolean }} */
    let outcome;
    try {
      // A failed background start is retried here rather than surfacing twice.
      await this.start().catch(() => {});
      if (this.needsReconnect || !this.client) {
        this._notice("Starting the orchestrator...");
        await this._connect({ threadId: this._chatThreadId() });
      }
      this._refreshProjectConfigs();
      if (this.interactive && this.settings.safetyMode === "interactive") this._startApprovalWatcher();

      const client = this.client;
      this.activeTurn = runTurn(
        client,
        () => client.startTurn(prompt, { model: this.settings.orchestratorModel, effort: this.settings.reasoningEffort }),
        { timeoutMs: this.settings.turnTimeoutMs }
      );
      outcome = await this.activeTurn.done;
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.activeTurn = null;
      this._turn = null;
      this._finishTurnTools();
      this._stopApprovalWatcher();
      this._settleApprovals("all", null, "the turn ended");
      this.busy = false;
    }

    const elapsedMs = Date.now() - startedAt;
    const text = transcript.join("");
    if (outcome.ok) {
      this._recordTurn(prompt, text, elapsedMs);
      this._emit("turn.completed", { turnId, text, elapsedMs });
    } else {
      this._emit("turn.failed", {
        turnId,
        reason: outcome.reason || "turn failed",
        elapsedMs,
        interrupted: Boolean(outcome.interrupted),
        timedOut: Boolean(outcome.timedOut),
      });
    }
    if (this._runQuotas) void this.quotas.refresh();
    return {
      ok: outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason || "turn failed" }),
      text,
      elapsedMs,
      interrupted: Boolean(outcome.interrupted),
      timedOut: Boolean(outcome.timedOut),
    };
  }

  /** Ask the running turn to stop; `send` resolves once it has. */
  interrupt() {
    this.activeTurn?.interrupt();
  }

  /**
   * @param {string} prompt
   * @param {string} text
   * @param {number} elapsedMs
   */
  _recordTurn(prompt, text, elapsedMs) {
    if (!this.persist || !this.chatId) return;
    this.turnCount++;
    this.store.appendTurn(this.workspace, this.chatId, {
      prompt,
      responseSummary: text || null,
      timestamp: Date.now(),
      model: this.settings.orchestratorModel,
      elapsedMs,
    });
    /** @type {Record<string, unknown>} */
    const update = {
      lastUsedAt: Date.now(),
      turns: this.turnCount,
      provider: this.settings.orchestratorProvider,
      threadId: this._clientThreadId(),
    };
    if (this.turnCount === 1) update.title = this.store.generateChatTitle(prompt);
    this.store.updateChat(this.workspace, this.chatId, update);
  }

  _clientThreadId() {
    const client = this.client;
    if (!client) return null;
    if (typeof client.currentThreadId === "function") return client.currentThreadId() || null;
    return null;
  }

  // ── worker calls ──

  /** @param {any} item */
  _onToolStarted(item) {
    if (!isToolCallItem(item)) return;
    // The model shown is the one the bridge will pick: the role's own, else
    // the shared worker's, with the call's arguments on top.
    const role = roleForTool(toolNameOf(item), this.settings.roles);
    const target = resolveRoleTarget(this.settings, role, /** @type {any} */ (toolArgsOf(item)));
    const call = this.tools.start(item, { role, model: target.model || null, effort: target.effort || null });
    if (!call) return;
    this._emit("tool.started", {
      turnId: this._turn?.id || null,
      toolId: call.id,
      name: call.name,
      role: call.role,
      task: call.task,
      model: call.model,
      effort: call.effort,
      startedAt: call.startedAt,
    });
    if (call.runId) {
      const held = this.tools.takeHeldOutput(call.runId);
      if (held) this._emit("tool.output", { toolId: call.id, text: held });
    } else if (!this.ipc || this.ipc.connectedBridges === 0) {
      // No bridge reached the engine: follow its live-log file instead.
      const tailer = new LiveLogTailer({
        workspace: this.workspace,
        toolId: call.id,
        onText: (text) => this._emit("tool.output", { toolId: call.id, text }),
      });
      this._tailers.set(call.id, tailer);
      tailer.start();
    }
  }

  /** @param {any} item */
  _onToolCompleted(item) {
    const call = this.tools.complete(item);
    if (!call) return;
    this._stopTailer(call.id);
    this._emit("tool.completed", {
      toolId: call.id,
      name: call.name,
      ok: !(item?.status === "failed" || item?.error),
      elapsedMs: Date.now() - call.startedAt,
    });
  }

  /** @param {{ runId?: string, tool?: string, task?: string }} params */
  _onRunStarted({ runId, tool, task }) {
    if (!runId) return;
    const call = this.tools.attachRun({ runId, tool: String(tool || ""), task: String(task || "") });
    if (!call) return;
    this._stopTailer(call.id);
    const held = this.tools.takeHeldOutput(runId);
    if (held) this._emit("tool.output", { toolId: call.id, text: held });
  }

  /** @param {{ runId?: string, text?: string }} params */
  _onRunOutput({ runId, text }) {
    if (!runId || !text) return;
    const routed = this.tools.outputFor(runId, String(text));
    if (routed) this._emit("tool.output", { toolId: routed.call.id, text: routed.text });
  }

  /** @param {string} toolId */
  _stopTailer(toolId) {
    const tailer = this._tailers.get(toolId);
    if (!tailer) return;
    this._tailers.delete(toolId);
    tailer.stop();
  }

  /** The turn ended: calls the orchestrator never closed are reported as unfinished. */
  _finishTurnTools() {
    for (const call of this.tools.clear()) {
      this._stopTailer(call.id);
      this._emit("tool.completed", { toolId: call.id, name: call.name, ok: false, elapsedMs: Date.now() - call.startedAt });
    }
    for (const id of [...this._tailers.keys()]) this._stopTailer(id);
  }

  // ── approvals ──

  /**
   * @param {any} cl
   * @param {any} req
   */
  _onServerRequest(cl, req) {
    if (cl !== this.client || !req?.isApproval) {
      req?.decline?.();
      return;
    }
    if (!this.interactive) {
      this._warn(`Declined (nobody is attached to approve): ${String(req.description || req.method).split("\n")[0]}`);
      req.decline();
      return;
    }
    const approvalId = randomUUID();
    this.pendingApprovals.set(approvalId, {
      kind: "orchestrator",
      resolve: (approved) => (approved ? req.approve() : req.decline()),
    });
    this._emit("approval.requested", {
      approvalId,
      kind: "orchestrator",
      tool: `${this.settings.orchestratorProvider}: ${req.method}`,
      preview: String(req.description || ""),
    });
  }

  /**
   * A bridge asks, over the engine connection, whether a previewed change may
   * be written (interactive safety mode).
   *
   * @param {{ previewId?: string, tool?: string, previewText?: string }} params
   * @returns {Promise<{ approved: boolean, reason?: string }>}
   */
  _requestWriteApproval({ previewId, tool, previewText }) {
    if (!this.interactive) {
      return Promise.resolve({ approved: false, reason: "nobody is attached to approve the change" });
    }
    return new Promise((resolve) => {
      const approvalId = previewId && !this.pendingApprovals.has(previewId) ? previewId : randomUUID();
      this.pendingApprovals.set(approvalId, {
        kind: "write",
        resolve: (approved, reason) =>
          resolve(approved ? { approved: true } : { approved: false, reason: reason || "the operator declined the change" }),
      });
      this._emit("approval.requested", {
        approvalId,
        kind: "write",
        tool: String(tool || "worker"),
        preview: String(previewText || ""),
      });
    });
  }

  /**
   * Answer a pending approval.
   *
   * @param {string} approvalId
   * @param {boolean} approved
   * @param {string} [reason]
   * @returns {boolean} false when nothing was waiting under that id
   */
  resolveApproval(approvalId, approved, reason) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(approvalId);
    pending.resolve(Boolean(approved), reason);
    this._emit("approval.resolved", { approvalId, approved: Boolean(approved), ...(reason ? { reason } : {}) });
    return true;
  }

  /**
   * Decline every pending approval (optionally only one kind).
   *
   * @param {"kind"|"all"} scope
   * @param {"write"|"orchestrator"|null} kind
   * @param {string} reason
   */
  _settleApprovals(scope, kind, reason) {
    for (const [id, pending] of [...this.pendingApprovals]) {
      if (scope === "kind" && pending.kind !== kind) continue;
      this.resolveApproval(id, false, reason);
    }
  }

  /**
   * For a bridge that could not reach the engine: it writes
   * `<previewId>.json` into the approval directory and waits for a
   * `<previewId>.decision.json` answer.
   */
  _startApprovalWatcher() {
    if (this._approvalTimer) return;
    this._approvalTimer = setInterval(() => this._pollApprovalFiles(), APPROVAL_POLL_MS);
    this._approvalTimer.unref();
  }

  _pollApprovalFiles() {
    let dir;
    let names;
    try {
      dir = this.store.getApprovalDir(this.workspace);
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".decision.json")) continue;
      const previewId = name.slice(0, -".json".length);
      if (this._seenApprovalFiles.has(previewId)) continue;
      if (fs.existsSync(path.join(dir, `${previewId}.decision.json`))) continue;
      let record;
      try {
        record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
      } catch {
        continue;
      }
      this._seenApprovalFiles.add(previewId);
      const approvalId = randomUUID();
      const decisionFile = path.join(dir, `${previewId}.decision.json`);
      this.pendingApprovals.set(approvalId, {
        kind: "write",
        resolve: (approved) => {
          try {
            fs.writeFileSync(decisionFile, JSON.stringify({ approved, decidedAt: Date.now() }, null, 2), {
              encoding: "utf-8",
              mode: 0o600,
            });
          } catch {
            /* the bridge times out on its own if it gets no answer */
          }
        },
      });
      this._emit("approval.requested", {
        approvalId,
        kind: "write",
        tool: String(record?.tool || "worker"),
        preview: String(record?.previewText || ""),
      });
    }
  }

  _stopApprovalWatcher() {
    if (this._approvalTimer) clearInterval(this._approvalTimer);
    this._approvalTimer = null;
  }

  // ── chats and workspaces ──

  /** @param {string} chatId */
  _chatRecord(chatId) {
    return this.store.listChats(this.workspace).find((c) => c.id === chatId) || null;
  }

  _newChatRecord() {
    return this.store.createChat(this.workspace, {
      model: this.settings.orchestratorModel,
      effort: this.settings.reasoningEffort,
    });
  }

  /** The current chat's provider thread, when it belongs to the current provider. */
  _chatThreadId() {
    if (!this.persist || !this.chatId) return this._clientThreadId();
    const chat = this._chatRecord(this.chatId);
    if (!chat || chat.provider !== this.settings.orchestratorProvider) return null;
    return chat.threadId || null;
  }

  _assertIdle() {
    if (this.closed) throw new Error("This session is closed.");
    if (this.busy) throw new Error("A turn is running; wait for it or interrupt it first.");
  }

  async _ensureClient() {
    await this.start().catch(() => {});
    if (this.needsReconnect || !this.client) await this._connect({});
  }

  _saveChatState() {
    if (this.persist && this.chatId) {
      this.store.updateChat(this.workspace, this.chatId, { lastUsedAt: Date.now(), turns: this.turnCount });
    }
  }

  /** Start a fresh conversation (a new chat and a new provider thread). */
  async newChat() {
    this._assertIdle();
    this._saveChatState();
    await this._ensureClient();
    await this._openThread({});
    this.chatId = this.persist ? this._newChatRecord() : null;
    this.turnCount = 0;
    this._emit("chat.changed", { workspace: this.workspace, chatId: this.chatId, title: "New Chat", resumed: false });
  }

  /**
   * Switch to an earlier chat of this workspace, resuming its provider thread
   * when the provider supports it (Codex, Claude Code, Antigravity).
   *
   * @param {string} chatId
   * @returns {Promise<{ resumed: boolean }>}
   */
  async openChat(chatId) {
    this._assertIdle();
    const chat = this._chatRecord(chatId);
    if (!chat) throw new Error(`No chat '${chatId}' in this workspace.`);
    this._saveChatState();
    await this._ensureClient();
    const threadId = chat.provider === this.settings.orchestratorProvider ? chat.threadId || null : null;
    const resumed = await this._openThread({ threadId });
    this.chatId = chat.id;
    this.turnCount = chat.turns || 0;
    this._emit("chat.changed", { workspace: this.workspace, chatId: chat.id, title: chat.title || "Chat", resumed });
    return { resumed };
  }

  /**
   * Move the session to another workspace, with a new chat there.
   *
   * @param {string} dir
   */
  async setWorkspace(dir) {
    this._assertIdle();
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
    this._saveChatState();
    this.workspace = resolved;
    if (this.persist) {
      this.store.registerProject(resolved);
      this.chatId = this._newChatRecord();
    }
    this.turnCount = 0;
    // The bridge is started for one workspace and the client env names it.
    await this._connect({});
    this._emit("chat.changed", { workspace: resolved, chatId: this.chatId, title: "New Chat", resumed: false });
  }

  /** @param {string} title */
  renameChat(title) {
    const clean = String(title || "").trim();
    if (!clean) throw new Error("A chat title cannot be empty.");
    if (this.persist && this.chatId) this.store.updateChat(this.workspace, this.chatId, { title: clean });
  }

  listChats() {
    return this.store.listChats(this.workspace);
  }

  turnLog() {
    return this.chatId ? this.store.loadTurnLog(this.workspace, this.chatId) : [];
  }

  /**
   * Write the chat as Markdown into the workspace.
   *
   * @param {string} [filename]
   * @returns {string} the file written
   */
  exportMarkdown(filename) {
    const log = this.turnLog();
    if (log.length === 0) throw new Error("No turns to save in the current conversation.");
    const out = path.resolve(this.workspace, filename || `kumo-session-${new Date().toISOString().slice(0, 10)}.md`);
    const s = this.settings;
    let md = `# Kumo Session — ${new Date().toLocaleDateString()}\n\n`;
    md += `**Workspace:** ${this.workspace}\n\n`;
    md += `**Orchestrator:** ${s.orchestratorModel}-${s.reasoningEffort} (${s.orchestratorProvider})\n\n`;
    md += `**Worker:** ${s.workerModel}-${s.workerEffort} (${s.workerProvider})\n\n---\n\n`;
    log.forEach((turn, i) => {
      md += `## Turn ${i + 1} (${new Date(turn.timestamp).toLocaleTimeString()})\n\n`;
      md += `**Prompt:**\n\n${turn.prompt}\n\n`;
      if (turn.responseSummary) md += `**Response:**\n\n${turn.responseSummary}\n\n`;
      md += `*Elapsed: ${((turn.elapsedMs || 0) / 1000).toFixed(1)}s*\n\n---\n\n`;
    });
    fs.writeFileSync(out, md, "utf-8");
    return out;
  }

  // ── settings ──

  /**
   * Change this session's settings. Worker, role and safety settings apply to
   * the next worker call (the bridge asks the session for them each time). A
   * model switch keeps the conversation; a provider switch starts a new one.
   * Adding or removing a custom role changes the bridge's tool list, which
   * the orchestrator reads when it starts: the client restarts and resumes
   * the same thread, so the conversation survives.
   *
   * @param {Partial<Record<string, unknown>>} patch
   * @param {{ persist?: boolean }} [opts] - also save as the global defaults
   * @returns {Promise<string[]>} the keys that changed
   */
  async updateSettings(patch, { persist = false } = {}) {
    if (this.closed) throw new Error("This session is closed.");
    const { next, changed } = applySettingsPatch(this.settings, patch);
    if (changed.length === 0) return changed;
    if (changed.includes("orchestratorProvider") && this.busy) {
      throw new Error("The orchestrator cannot change while a turn is running.");
    }
    const toolsChanged = roleToolSignature(this.settings.roles) !== roleToolSignature(next.roles);
    this.settings = next;
    if (persist) {
      for (const key of changed) setConfigValue(key, /** @type {Record<string, unknown>} */ (next)[key]);
    }

    if (changed.includes("orchestratorProvider")) {
      this.quotas.providerChanged();
      if (this.client || this._ready) await this._connect({});
    } else if (toolsChanged && this.client) {
      // A running turn keeps its tools; the next one starts on the new list.
      if (this.busy) this.needsReconnect = true;
      else await this._connect({ threadId: this._clientThreadId() });
    } else if (changed.includes("orchestratorModel") || changed.includes("reasoningEffort")) {
      await this.client?.applyModel?.({ model: next.orchestratorModel, reasoningEffort: next.reasoningEffort });
    } else if (changed.includes("safetyMode") && this.settings.orchestratorProvider === "antigravity" && !this.busy) {
      // agy fixes its permission mode when it starts.
      if (this.client) await this._connect({ threadId: this._clientThreadId() });
    }
    this._emit("settings.changed", { settings: { ...this.settings }, changed });
    if (!changed.includes("orchestratorProvider") && (changed.includes("workerProvider") || changed.includes("roles"))) {
      this.quotas.providerChanged();
    }
    return changed;
  }

  // ── quotas ──

  /** Fetch fresh quota figures now (an explicit /status or /refresh). */
  refreshQuotas() {
    return this.quotas.refresh({ force: true });
  }

  // ── teardown ──

  _refreshProjectConfigs() {
    // Only workspaces that opted in through `kumo init` are written to.
    try {
      syncAgentConfigs(this.workspace, { ...loadConfig(), ...this.settings }, { onlyIfManaged: true });
    } catch {
      /* a project file Kumo cannot update must not block the session */
    }
  }

  /** Stop everything this session started. */
  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.activeTurn?.interrupt("session closed");
    this._finishTurnTools();
    this._stopApprovalWatcher();
    this._settleApprovals("all", null, "the session closed");
    this.quotas.stop();
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        await client.stop();
      } catch {}
    }
    if (this.ipc) {
      await this.ipc.close();
      this.ipc = null;
    }
    this._emit("session.closed", {});
  }
}
