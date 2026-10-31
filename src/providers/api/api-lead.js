/**
 * api-lead.js — A lead that runs on a direct-API model (openai-api,
 * compat-api, anthropic-api, gemini-api) or a local Ollama server, and still
 * delegates.
 *
 * The API providers have no agent of their own, so Kumo runs the loop: it
 * connects to the worker bridge as an MCP client, offers the bridge's tools
 * (`worker_explore`, `worker_implement`, … and any custom role) to the model,
 * runs the calls the model makes and sends their results back, until the model
 * answers. The conversation is kept per thread, in memory. The bridge cannot
 * cancel a worker, so a turn interrupted in the middle of a worker call ends
 * the bridge (and with it the worker); the next turn starts another.
 *
 * Events match the other leads (see claude-client.js): `delta` (the model's
 * text), `reasoning`, `item_started` / `item_completed` (one `mcpToolCall`
 * item per worker call), `warning`, `notice`, and `turn_completed` when a turn
 * is interrupted or finishes. A failed turn rejects `startTurn`.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chatWithTools, ApiError } from "./api-transport.js";
import { bridgeLaunch, BRIDGE_SERVER_NAME } from "../orchestrators/lead-support.js";
import { bridgeEnvFrom, childEnvFor, stopProcessTree } from "../../utils/process.js";
import { activeProviders } from "../../config/roles.js";
import { providerDisplayName } from "../../config/models.js";

/** Model requests one turn may make before it is stopped as a runaway loop. */
export const MAX_ITERATIONS = 25;
/** A worker's reply, clipped before it goes back to the model. */
const MAX_TOOL_RESULT_CHARS = 60_000;
/** What a thread keeps of its history; the oldest turns go first. */
const HISTORY_BUDGET_CHARS = 320_000;
/** How long the bridge has to start. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Matches the session's default turn ceiling; a worker call may take most of a turn. */
const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60 * 1000;
/** Conversations kept in memory across lead restarts (a role change restarts the lead). */
const MAX_THREADS = 16;

/**
 * What the model is told it is. The tools carry their own contracts (each
 * description names the role and the model it runs on), so this only sets the
 * lead's part.
 *
 * @param {string} workspace
 */
export function leadSystemPrompt(workspace) {
  return [
    `You are the lead of Kumo, a cross-provider coding assistant. You work in the user's workspace: ${workspace}`,
    "",
    "You plan, decide and answer; the worker_* tools do the hands-on work. Each tool is a role that runs on its own model, and its description says which: scouts explore the code, builders change it, testers run tests, reviewers check changes, researchers look things up, designers do visual work, and the user may add roles of their own. You cannot read or change files or run commands yourself, so delegate whatever needs the workspace.",
    "",
    "Brief a worker the way you would a colleague: one outcome, the files it owns, the constraints, and how you will tell it is done. Keep each call bounded and split large jobs into steps. Never run two write calls on overlapping files at once. A worker's reply is its report, not the truth: check what matters before you tell the user it is done.",
    "",
    "When no workspace access is needed, answer directly. Be concise.",
  ].join("\n");
}

// ── conversations ──

/** @typedef {{ id: string, messages: import("./tool-wire.js").LeadMessage[] }} Thread */

/** @type {Map<string, Thread>} newest last */
const THREADS = new Map();

/** @returns {Thread} */
function newThread() {
  return { id: randomUUID(), messages: [] };
}

/** @param {Thread} thread */
function remember(thread) {
  THREADS.delete(thread.id);
  THREADS.set(thread.id, thread);
  while (THREADS.size > MAX_THREADS) THREADS.delete(/** @type {string} */ (THREADS.keys().next().value));
}

/** Forget every conversation held in memory (for tests; a restart does the same). */
export function forgetApiLeadThreads() {
  THREADS.clear();
}

/**
 * Drop the oldest turns of a thread until it fits the budget. The newest turn
 * always stays.
 *
 * @param {Thread} thread
 * @param {number} maxChars
 * @returns {number} how many turns were dropped
 */
function trimThread(thread, maxChars) {
  const sizes = thread.messages.map((m) => JSON.stringify(m).length);
  let total = sizes.reduce((a, b) => a + b, 0);
  const starts = thread.messages.flatMap((m, i) => (m.role === "user" && m.turnStart ? [i] : []));
  let cut = 0;
  let dropped = 0;
  for (let k = 1; k < starts.length && total > maxChars; k++) {
    for (let i = cut; i < starts[k]; i++) total -= sizes[i];
    cut = starts[k];
    dropped++;
  }
  if (cut > 0) thread.messages.splice(0, cut);
  return dropped;
}

// ── the worker bridge, as an MCP client ──

/**
 * @typedef {{
 *   closed: boolean,
 *   pid?: number|null,
 *   listTools: () => Promise<import("./tool-wire.js").ToolSpec[]>,
 *   callTool: (name: string, args: Record<string, any>, opts: { signal?: AbortSignal, timeoutMs?: number }) => Promise<{ text: string, isError: boolean }>,
 *   close: () => Promise<void>,
 * }} BridgeConnection
 */

/** The text of an MCP tool result; other content is named, not inlined. */
function resultText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts
    .map((p) => (p?.type === "text" ? String(p.text ?? "") : p?.type ? `[${p.type}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The environment the bridge starts with: this process's, minus credential-like
 * names, then `launchEnv` on top. The MCP SDK gives a child only its own short
 * list of variables plus the `env` it is passed, so without this the bridge
 * would lose KUMO_SAFETY_MODE (an operator's stricter override), the worker
 * provider, proxy and CA settings and CODEX_HOME that the other leads' bridges
 * inherit. `launchEnv` is applied last, so what the session hands the bridge
 * (its token and keys, the Electron run-as-node switch) still arrives.
 *
 * @param {Record<string, string>} launchEnv
 * @returns {Record<string, string>}
 */
export function bridgeChildEnv(launchEnv) {
  return childEnvFor("kumo-bridge", launchEnv);
}

/**
 * A stand-in for a child process that stopProcessTree can act on, made from
 * the pid alone: the SDK's transport keeps its process to itself.
 *
 * @param {number} pid
 * @returns {import("node:child_process").ChildProcess}
 */
export function pidHandle(pid) {
  return /** @type {any} */ ({ pid, exitCode: null, signalCode: null, kill: (/** @type {NodeJS.Signals} */ signal) => process.kill(pid, signal) });
}

/**
 * Start the bridge the way the other leads do and connect to it over stdio.
 * `env` is what the session hands its leads (engine endpoint and token, the
 * bridge's own variables); it goes to the child's environment, never to disk
 * or a command line.
 *
 * Closing the connection ends the bridge and every worker it started.
 *
 * @param {{ workspace: string, env?: Record<string, string>, signal?: AbortSignal }} opts
 * @returns {Promise<BridgeConnection>}
 */
export async function connectBridge({ workspace, env = {}, signal }) {
  const launch = bridgeLaunch({ workspace, env });
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: bridgeChildEnv(launch.env),
    stderr: "pipe",
  });
  // Piped stderr must be drained; its tail also explains a failed start.
  let stderrTail = "";
  transport.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-600);
  });
  const client = new Client({ name: "kumo-api-lead", version: "1.0.0" }, { capabilities: {} });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  try {
    await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    closed = true;
    await transport.close().catch(() => {});
    const tail = stderrTail.trim();
    throw new Error(`${err instanceof Error ? err.message : err}${tail ? ` (${tail})` : ""}`);
  }
  const pid = transport.pid;
  return {
    get closed() {
      return closed;
    },
    get pid() {
      return pid;
    },
    async listTools() {
      /** @type {import("./tool-wire.js").ToolSpec[]} */
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) tools.push({ name: t.name, description: t.description, inputSchema: /** @type {any} */ (t.inputSchema) });
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, { signal: callSignal, timeoutMs } = {}) {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal: callSignal, timeout: timeoutMs });
      return { text: resultText(result), isError: result.isError === true };
    },
    async close() {
      closed = true;
      // The bridge ignores MCP cancellation and has no way to stop a running
      // worker, and closing stdio ends only the bridge: on Windows a worker run
      // with --force or --yolo would carry on editing the workspace. So the
      // whole tree goes first. The transport has no pid once the bridge has
      // exited, so a pid the system has handed to someone else is never hit.
      const live = transport.pid;
      if (live) stopProcessTree(pidHandle(live));
      await client.close().catch(() => {});
    },
  };
}

/**
 * The promise's outcome, or the signal's reason as soon as it aborts. The
 * promise itself carries on: a bridge connection outlives the turn that
 * waited for it.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const clip = (text) =>
  text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[${text.length - MAX_TOOL_RESULT_CHARS} characters omitted]` : text;

// ── the client ──

/**
 * Orchestrator client for a lead on a direct-API model. Providers differ only
 * in `provider` (see openai-api-client.js, anthropic-api-client.js,
 * gemini-api-client.js, ollama-client.js).
 *
 * Options beyond the usual ones: `connectBridge` (a replacement for
 * {@link connectBridge}), `baseUrl`, `systemPrompt`, `maxIterations`,
 * `toolTimeoutMs`, `requestTimeoutMs`, `historyChars`.
 */
export class ApiLeadClient extends EventEmitter {
  /** Model used when none is configured; null means the turn needs one. */
  defaultModel = null;

  /** @param {Record<string, any>} options */
  constructor(options = {}) {
    super();
    this.options = options;
    this.provider = options.provider;
    this.activeModel = options.model || null;
    this.activeEffort = options.effort || null;
    this.workspace = options.workspace || process.cwd();
    this.env = options.env || {};
    this.config = options.config || {};
    this.isTurnActive = false;
    /** @type {Thread|null} */
    this.thread = null;
    /** @type {{ controller: AbortController, executed: number, spoke: boolean }|null} */
    this._turn = null;
    /** @type {Promise<void>|null} settles when the last turn has closed its history */
    this._unwinding = null;
    /** @type {{ workspace: string, controller: AbortController, pending: Promise<BridgeConnection>, connection?: BridgeConnection }|null} */
    this._bridge = null;
    /** @type {Set<Promise<void>>} bridges being taken down; none of them can fail */
    this._closing = new Set();
  }

  async start() {
    return Promise.resolve();
  }

  /** @param {{ workspace?: string, model?: string, reasoningEffort?: string }} [opts] */
  _adopt({ workspace, model, reasoningEffort } = {}) {
    if (workspace) this.workspace = workspace;
    if (model) this.activeModel = model;
    if (reasoningEffort) this.activeEffort = reasoningEffort;
  }

  async startThread(opts = {}) {
    this._adopt(opts);
    this.thread = newThread();
    return { ok: true, threadId: this.thread.id };
  }

  /**
   * Continue a conversation still held in memory: a chat reopened in the same
   * run, or a lead restarted for a role change. After an app restart it is gone
   * and this throws; the session then starts a new thread and puts the chat's
   * earlier turns in front of the next prompt.
   *
   * @param {{ threadId: string, workspace?: string, model?: string, reasoningEffort?: string }} opts
   */
  async resumeThread(opts) {
    const thread = THREADS.get(opts.threadId);
    if (!thread) {
      throw new Error("this lead keeps its conversation in memory only, and Kumo has restarted since; the earlier turns go into the next prompt instead");
    }
    this._adopt(opts);
    remember(thread);
    this.thread = thread;
    return { ok: true, threadId: thread.id, resumed: true };
  }

  /** The id of a conversation that has history and can be resumed, or null. */
  currentThreadId() {
    return this.thread && this.thread.messages.length > 0 ? this.thread.id : null;
  }

  /** @param {{ model?: string, reasoningEffort?: string }} opts */
  async applyModel({ model, reasoningEffort } = {}) {
    if (model) this.activeModel = model;
    if (reasoningEffort) this.activeEffort = reasoningEffort;
  }

  get _label() {
    return providerDisplayName(this.provider);
  }

  /**
   * Run one turn: the prompt goes to the model with the worker tools, and the
   * calls it makes are run until it answers.
   *
   * @param {string} prompt
   * @param {{ model?: string|null, effort?: string|null }} [opts]
   * @returns {Promise<{ ok: boolean, text?: string, stale?: boolean }>}
   */
  async startTurn(prompt, { model, effort } = {}) {
    const turn = { controller: new AbortController(), executed: 0, spoke: false };
    // A turn still running is superseded: it ends without reporting.
    this._turn?.controller.abort();
    this._turn = turn;
    this.isTurnActive = true;
    const previous = this._unwinding;
    /** @type {() => void} */
    let unwound = () => {};
    this._unwinding = new Promise((resolve) => {
      unwound = resolve;
    });

    /** @type {import("./tool-wire.js").LeadMessage[]} */
    const pending = [];
    /** @type {Thread|null} */
    let thread = null;
    try {
      // An interrupted turn closes its history first: the two must not interleave.
      await previous;
      turn.controller.signal.throwIfAborted();
      if (!this.thread) await this.startThread();
      thread = /** @type {Thread} */ (this.thread);
      const dropped = trimThread(thread, this.options.historyChars ?? HISTORY_BUDGET_CHARS);
      if (dropped > 0) {
        const oldest = dropped === 1 ? "turn of this conversation no longer fits the model's context and was" : `${dropped} turns of this conversation no longer fit the model's context and were`;
        this.emit("notice", `The oldest ${oldest} dropped from it.`);
      }
      const text = await this._run({
        turn,
        thread,
        pending,
        prompt,
        model: model || this.activeModel || this.defaultModel,
        effort: effort || this.activeEffort,
      });
      if (this._turn !== turn) {
        // Interrupted just as the answer arrived: it is not this turn's to give.
        this._settleHistory(thread, pending, turn.executed, "interrupted");
        return { ok: false, stale: true };
      }
      thread.messages.push(...pending);
      remember(thread);
      this._turn = null;
      this.isTurnActive = false;
      this.emit("turn_completed", { ok: true });
      return { ok: true, text };
    } catch (err) {
      const interrupted = turn.controller.signal.aborted;
      if (thread) this._settleHistory(thread, pending, turn.executed, interrupted ? "interrupted" : err instanceof Error ? err.message : String(err));
      // Interrupted, superseded or stopped: that turn is already closed.
      if (this._turn !== turn) return { ok: false, stale: true };
      this._turn = null;
      this.isTurnActive = false;
      throw this._explain(err);
    } finally {
      unwound();
    }
  }

  /**
   * Keep what a turn that did not finish left behind. A turn that only talked
   * leaves no trace; one that ran worker calls stays, closed with a note, so the
   * model knows on the next turn what was done and that the turn ended early.
   *
   * @param {Thread} thread
   * @param {import("./tool-wire.js").LeadMessage[]} pending
   * @param {number} executed worker calls the turn dispatched
   * @param {string} reason
   */
  _settleHistory(thread, pending, executed, reason) {
    if (executed === 0 || pending.length === 0) return;
    const last = pending[pending.length - 1];
    if (last.role === "assistant" && last.toolCalls?.length) {
      pending.push({
        role: "tool",
        results: last.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          text: "Not run: the turn ended first.",
          isError: true,
          ...(c.synthetic ? { synthetic: true } : {}),
        })),
      });
    }
    if (!(last.role === "assistant" && !last.toolCalls?.length)) {
      pending.push({ role: "assistant", text: `[This turn ended early: ${reason}]` });
    }
    thread.messages.push(...pending);
    remember(thread);
  }

  /** A refusal of tools is the likely reason for an HTTP 4xx that mentions them; say what that means here. */
  _explain(err) {
    if (err instanceof ApiError && err.status >= 400 && err.status < 500 && /\btools?\b|function/i.test(err.message)) {
      return new ApiError(err.provider, err.status, `${err.message} (a lead needs a model that supports tool calling to reach the workers)`);
    }
    return err;
  }

  /** @param {{ turn: any, thread: Thread, pending: import("./tool-wire.js").LeadMessage[], prompt: string, model: string|null, effort: string|null }} args */
  async _run({ turn, thread, pending, prompt, model, effort }) {
    const signal = turn.controller.signal;
    const maxIterations = this.options.maxIterations ?? MAX_ITERATIONS;
    pending.push({ role: "user", text: prompt, turnStart: true });

    const bridge = await this._bridgeFor(signal);
    // Listed every turn: a role's model, and so its description, can change.
    const tools = await abortable(bridge.listTools(), signal);
    const known = new Set(tools.map((t) => t.name));
    const system = this.options.systemPrompt ?? leadSystemPrompt(this.workspace);
    const said = [];

    for (let i = 0; i < maxIterations; i++) {
      signal.throwIfAborted();
      const reply = await chatWithTools({
        provider: this.provider,
        model: /** @type {string} */ (model),
        system,
        messages: [...thread.messages, ...pending],
        tools,
        effort: effort || undefined,
        signal,
        baseUrl: this.options.baseUrl,
        timeoutMs: this.options.requestTimeoutMs,
        config: this.config,
      });
      signal.throwIfAborted();

      if (reply.reasoning) this.emit("reasoning", reply.reasoning);
      if (reply.text.trim()) {
        // Text written before and after a worker call would otherwise run together.
        if (turn.spoke) this.emit("delta", "\n\n");
        turn.spoke = true;
        this.emit("delta", reply.text);
        said.push(reply.text);
      }
      pending.push({ role: "assistant", text: reply.text, toolCalls: reply.toolCalls, wire: reply.wire });

      if (reply.toolCalls.length === 0) {
        if (!reply.text.trim()) {
          throw new Error(reply.stopReason === "filtered" ? `${this._label} withheld its answer (content filter)` : `${this._label} returned no answer`);
        }
        if (reply.stopReason === "max_tokens") this.emit("warning", { message: `${this._label} cut its answer off at its output limit.` });
        return said.join("\n\n");
      }

      // Calls from one reply run together, as the other leads run them.
      const results = await Promise.all(reply.toolCalls.map((call) => this._callTool(bridge, call, known, turn)));
      pending.push({ role: "tool", results });
    }
    throw new Error(`${this._label} made ${maxIterations} requests in one turn without answering; stopped.`);
  }

  /**
   * Run one worker call. A call that cannot run, or fails, comes back as an
   * error result the model reads; nothing here throws.
   *
   * @param {BridgeConnection} bridge
   * @param {import("./tool-wire.js").ToolCall} call
   * @param {Set<string>} known
   * @param {{ controller: AbortController, executed: number }} turn
   * @returns {Promise<import("./tool-wire.js").ToolResult>}
   */
  async _callTool(bridge, call, known, turn) {
    const signal = turn.controller.signal;
    const base = { id: call.id, name: call.name, ...(call.synthetic ? { synthetic: true } : {}) };
    if (call.argsError) return { ...base, isError: true, text: `Not run: ${call.argsError}.` };
    if (!known.has(call.name)) {
      return { ...base, isError: true, text: `Not run: there is no tool named '${call.name}'. The tools are: ${[...known].join(", ")}.` };
    }
    if (signal.aborted) return { ...base, isError: true, text: "Not run: the turn was interrupted first." };

    // Own id: the provider's may be missing, repeated or unsafe as a file name.
    const item = { id: randomUUID(), type: "mcpToolCall", server: BRIDGE_SERVER_NAME, tool: call.name, arguments: call.args, status: "inProgress" };
    turn.executed++;
    this.emit("item_started", { item });
    /** @type {{ text: string, isError: boolean }} */
    let outcome;
    try {
      outcome = await abortable(
        bridge.callTool(call.name, call.args, {
          signal,
          timeoutMs: this.options.toolTimeoutMs ?? (this.config.turnTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS),
        }),
        signal
      );
    } catch (err) {
      outcome = {
        isError: true,
        text: signal.aborted ? "Interrupted before this call finished." : `The call failed: ${err instanceof Error ? err.message : err}`,
      };
      // The bridge cannot cancel a worker, and stopping the wait does not stop it:
      // it would carry on in the workspace and the bridge would still apply its diff.
      // The next turn starts a bridge of its own.
      if (signal.aborted) void this._dropBridge(bridge);
    }
    // An interrupted turn has already been reported; the session closes its calls.
    if (!signal.aborted) {
      this.emit("item_completed", { item: { ...item, status: outcome.isError ? "failed" : "completed" } });
    }
    return { ...base, isError: outcome.isError, text: clip(outcome.text) };
  }

  /**
   * The connection to the bridge, started on first use and reused across
   * turns, unless a turn was interrupted in the middle of a worker call (see
   * {@link ApiLeadClient#_dropBridge}). A turn that stops waiting for the start
   * does not cancel it: the next one finds it done.
   *
   * @param {AbortSignal} signal
   * @returns {Promise<BridgeConnection>}
   */
  async _bridgeFor(signal) {
    // A bridge being taken down is gone before the next one starts, so the
    // workers it ran cannot overlap this turn's.
    if (this._closing.size > 0) await abortable(Promise.all(this._closing), signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this._bridge) {
        const workspace = this.workspace;
        const controller = new AbortController();
        const connect = this.options.connectBridge || connectBridge;
        const pending = Promise.resolve()
          .then(() => connect({ workspace, env: this._bridgeEnv(), signal: controller.signal }))
          .catch((err) => {
            throw new Error(`Could not start Kumo's worker bridge: ${err instanceof Error ? err.message : err}`);
          });
        const holder = { workspace, controller, pending };
        this._bridge = holder;
        // A failed start is retried by the next turn.
        pending.catch(() => {
          if (this._bridge === holder) this._bridge = null;
        });
      }
      const holder = this._bridge;
      const connection = await abortable(holder.pending, signal);
      holder.connection = connection;
      if (!connection.closed && holder.workspace === this.workspace) return connection;
      // The bridge exited, or the workspace moved: start another.
      if (this._bridge === holder) this._bridge = null;
      await connection.close().catch(() => {});
    }
    throw new Error("Kumo's worker bridge keeps closing");
  }

  /** What the bridge is started with: its own variables from this process, then the session's. */
  _bridgeEnv() {
    const providers = this.options.config ? activeProviders(this.options.config) : [];
    return { ...bridgeEnvFrom(process.env, providers), ...this.env };
  }

  async interruptTurn() {
    const turn = this._turn;
    this._turn = null;
    turn?.controller.abort();
    this.isTurnActive = false;
    this.emit("turn_completed", { ok: false, reason: "interrupted" });
  }

  async getRateLimits() {
    return null;
  }

  /**
   * Take the bridge down: give up a start still under way, then close the
   * connection, which ends the bridge and the workers it started. Nothing here
   * throws. The returned promise settles once the close is done; a caller that
   * does not wait for it can still find it in `_closing`.
   *
   * @param {BridgeConnection} [only] the connection an interrupted call was
   *   using: if the bridge held now is another (a new turn has started its own),
   *   it is left alone
   * @returns {Promise<void>}
   */
  _dropBridge(only) {
    const holder = this._bridge;
    if (!holder || (only && holder.connection !== only)) return Promise.resolve();
    this._bridge = null;
    holder.controller.abort();
    const closing = holder.pending
      .catch(() => null)
      .then((connection) => connection?.close())
      .catch(() => {})
      .finally(() => this._closing.delete(closing));
    this._closing.add(closing);
    return closing;
  }

  async stop() {
    const turn = this._turn;
    this._turn = null;
    this.isTurnActive = false;
    turn?.controller.abort();
    // The turn closes its history first. A worker call it was in the middle of
    // has already started the bridge's removal; this waits for that too, so no
    // worker is left running when stop() returns.
    await this._unwinding;
    void this._dropBridge();
    await Promise.all(this._closing);
  }
}
