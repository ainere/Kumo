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
import { loadConfig, setConfigValue, stricterSafetyMode } from "../config/settings.js";
import { syncAgentConfigs } from "../config/sync.js";
import { createOrchestratorClient, orchestratorDelegates } from "../providers/orchestrators/registry.js";
import { isToolCallItem, toolNameOf, toolArgsOf } from "../providers/orchestrators/items.js";
import { emptyRoles, roleForTool, resolveRoleTarget, roleToolSignature } from "../config/roles.js";
import { runTurn } from "../providers/orchestrators/turn-wait.js";
import * as defaultStore from "../data/sessions.js";
import { makeEvent } from "./events.js";
import { snapshotSettings, applySettingsPatch } from "./settings.js";
import { profileText, profilePreamble } from "./profile.js";
import { providerDisplayName } from "../config/models.js";
import { ToolTracker, TurnTrace } from "./tool-tracker.js";
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

/** Folders git and the agent CLIs read their hooks, rules and settings from; an export never lands in one. */
const PROTECTED_EXPORT_DIRS = new Set([".git", ".codex", ".claude", ".agents", ".gemini"]);

/** Files the agent CLIs load as standing instructions; a conversation must not be written over one. */
const PROTECTED_EXPORT_FILES = new Set(["agents.md", "claude.md", "claude.local.md", "gemini.md"]);

/** Names Windows treats as devices, with or without an extension; an export folder is never one. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Leads whose own permissions are fixed by the safety mode their client was
 * built with (Antigravity when it starts, Copilot and OpenCode in the flags
 * and config of every turn), so a new mode needs a new client.
 */
const TIER_BOUND_LEADS = new Set(["antigravity", "copilot", "opencode"]);

/**
 * How much of the chat so far goes in front of the first prompt on a new lead
 * provider. The newest turns win; each part of a turn is clipped, so one
 * long answer cannot crowd out the rest.
 */
const REPLAY_MAX_CHARS = 48_000;
/** Room kept inside REPLAY_MAX_CHARS for the preamble's own wording. */
const REPLAY_FRAME_CHARS = 700;
const REPLAY_PROMPT_CHARS = 6_000;
const REPLAY_ANSWER_CHARS = 12_000;
const REPLAY_TASK_CHARS = 200;
const REPLAY_TOOL_LINES = 30;
/** Worker calls and changed files listed under a turn in an exported Markdown file. */
const EXPORT_LIST_ITEMS = 20;

/**
 * How links are resolved on the workspace's filesystem. The native call is
 * best; some drives (RAM disks, network shares) refuse it, so the JavaScript
 * walk is next, and without either paths are only made absolute. Picked once
 * for the workspace and used for the target too, so both are judged alike.
 *
 * @param {string} workspace
 * @returns {(p: string) => string}
 */
function linkResolverFor(workspace) {
  /** @type {Array<(p: string) => string>} */
  const resolvers = [(p) => fs.realpathSync.native(p), (p) => fs.realpathSync(p), (p) => path.resolve(p)];
  for (const resolve of resolvers) {
    try {
      resolve(workspace);
      return resolve;
    } catch (err) {
      // A workspace that is not there is an error whatever the filesystem.
      if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") throw err;
    }
  }
  return path.resolve;
}

/**
 * `p` with the links resolved in the part of it that exists; what does not
 * exist yet cannot be a link and is kept as written.
 *
 * @param {string} p
 * @param {(p: string) => string} realpath
 * @returns {string}
 */
function resolveExisting(p, realpath) {
  /** @type {string[]} */
  const missing = [];
  let dir = p;
  for (;;) {
    try {
      return path.join(realpath(dir), ...missing.reverse());
    } catch (err) {
      const parent = path.dirname(dir);
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "ENOENT" || parent === dir) throw err;
      missing.push(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Where `exportMarkdown` may write `filename`: inside `workspace`, outside the
 * protected folders, not an agent-instruction file, and not through a link
 * (symbolic or hard). The name comes from outside the engine (the desktop
 * renderer), so this holds whatever the command schema let through.
 *
 * @param {string} workspace
 * @param {string} filename
 * @returns {string} the absolute path to write
 */
function exportTarget(workspace, filename) {
  if (filename.includes(String.fromCharCode(0))) throw new Error("The file name contains a NUL character.");
  const asGiven = path.resolve(workspace, filename);
  if (fs.lstatSync(asGiven, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`'${filename}' is a link; export to a regular file.`);
  }
  // Both sides go through the same resolution, so a link in a folder name is judged by where it leads.
  const realpath = linkResolverFor(workspace);
  const root = realpath(workspace);
  const target = resolveExisting(asGiven, realpath);
  const rel = path.relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`'${filename}' is outside the workspace; export to a file inside it.`);
  }
  // ':' names an NTFS data stream or a drive; neither is part of a file name here.
  if (process.platform === "win32" && rel.includes(":")) throw new Error(`'${filename}' is not a plain file path.`);
  if (rel.split(path.sep).some((part) => PROTECTED_EXPORT_DIRS.has(part.toLowerCase()))) {
    throw new Error(`'${filename}' is inside a protected folder (${[...PROTECTED_EXPORT_DIRS].join(", ")}).`);
  }
  if (PROTECTED_EXPORT_FILES.has(path.basename(target).toLowerCase())) {
    throw new Error(`'${filename}' is an agent instruction file; export to another name.`);
  }
  // Writing through a second name for a file would overwrite that file, wherever its other name is.
  const existing = fs.lstatSync(target, { throwIfNoEntry: false });
  if (existing?.isFile() && existing.nlink > 1) {
    throw new Error(`'${filename}' is a hard link to another file; export to a new name.`);
  }
  return target;
}

/**
 * The workspace-relative paths a unified diff changes, read from its
 * `---`/`+++` headers: git's `a/` `b/` prefixes are removed when every header
 * has them (as the bridge applies the diff), /dev/null is skipped and
 * separators become "/". A header pair counts only when a hunk follows, so a
 * removed line that reads `-- x` followed by an added `++ y` is not a file.
 * The preview is text from a worker, so a path that leaves the workspace is
 * dropped rather than recorded.
 *
 * @param {string} previewText
 * @returns {string[]}
 */
export function diffPathsOf(previewText) {
  const lines = String(previewText || "").split(/\r?\n/);
  /** @param {string} line */
  const pathOf = (line) => line.slice(4).split("\t")[0].trim().replace(/^"(.*)"$/, "$1");
  /** @type {string[]} */
  const headers = [];
  for (let i = 0; i + 2 < lines.length; i++) {
    if (!lines[i].startsWith("--- ") || !lines[i + 1].startsWith("+++ ") || !lines[i + 2].startsWith("@@")) continue;
    for (const p of [pathOf(lines[i]), pathOf(lines[i + 1])]) {
      if (p && p !== "/dev/null") headers.push(p);
    }
    i += 2;
  }
  const prefixed = headers.length > 0 && headers.every((p) => /^[ab]\//.test(p));
  /** @type {Set<string>} */
  const paths = new Set();
  for (const header of headers) {
    const rel = path.posix.normalize((prefixed ? header.slice(2) : header).replace(/\\/g, "/"));
    if (rel === "." || rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) continue;
    paths.add(rel);
  }
  return [...paths];
}

/** @param {unknown} text */
const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

/**
 * @param {string} text
 * @param {number} max
 * @param {"head"|"tail"} keep which end survives
 */
function clip(text, max, keep) {
  if (text.length <= max) return text;
  const note = `[${text.length - max} characters omitted]`;
  return keep === "head" ? `${text.slice(0, max)} ${note}` : `${note} ${text.slice(text.length - max)}`;
}

/** How a worker call ended, in a word. @param {{ ok?: boolean|null }} tool */
const outcomeWord = (tool) => (tool.ok === true ? "ok" : tool.ok === false ? "failed" : "unfinished");

/**
 * One earlier turn as the replay shows it: the prompt, the lead's answer and a
 * line per worker call. Reasoning stays out; it can be huge and means little
 * to another model.
 *
 * @param {any} turn
 * @param {number} number
 */
function replayTurn(turn, number) {
  const answer = oneLine(turn.responseSummary) ? String(turn.responseSummary).trim() : "(no answer)";
  const lines = [
    `Turn ${number}`,
    `User: ${clip(String(turn.prompt ?? "").trim(), REPLAY_PROMPT_CHARS, "head")}`,
    `Lead: ${clip(answer, REPLAY_ANSWER_CHARS, "tail")}`,
  ];
  const tools = Array.isArray(turn.tools) ? turn.tools : [];
  if (tools.length > 0) {
    lines.push("Worker calls:");
    for (const tool of tools.slice(0, REPLAY_TOOL_LINES)) {
      lines.push(`- ${tool.role || tool.name || "worker"} (${outcomeWord(tool)}): ${clip(oneLine(tool.task), REPLAY_TASK_CHARS, "head")}`);
    }
    if (tools.length > REPLAY_TOOL_LINES) lines.push(`- ... and ${tools.length - REPLAY_TOOL_LINES} more`);
  }
  // The block sits inside a tag: a turn's own text must not close it.
  return lines.join("\n").replaceAll("</kumo-replay>", "</ kumo-replay>");
}

/**
 * The text that goes in front of the first prompt on a new lead provider so
 * the chat's earlier turns reach it. Newest turns win when it has to be cut.
 *
 * @param {unknown[]} turns the chat's turn log, oldest first
 * @param {number} [maxChars]
 * @returns {string|null} null when there is nothing to carry over
 */
export function replayPreamble(turns, maxChars = REPLAY_MAX_CHARS) {
  const log = (Array.isArray(turns) ? turns : []).filter((t) => t && typeof t === "object");
  if (log.length === 0) return null;
  /** @type {string[]} */
  const blocks = [];
  let used = REPLAY_FRAME_CHARS;
  for (let i = log.length - 1; i >= 0; i--) {
    const block = replayTurn(log[i], i + 1);
    // The newest turn always goes in, whatever the limit.
    if (blocks.length > 0 && used + block.length + 2 > maxChars) break;
    blocks.unshift(block);
    used += block.length + 2;
  }
  const omitted = log.length - blocks.length;
  return [
    "<kumo-replay>",
    "This chat was handed to you from another model. Its earlier turns follow, oldest first, as context. They are done: do not repeat or redo them.",
    ...(omitted > 0 ? ["", `[${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted]`] : []),
    "",
    blocks.join("\n\n"),
    "</kumo-replay>",
    "",
    "Continue the conversation from there. The user's new message:",
  ].join("\n");
}

/**
 * A turn's worker calls and changed files as they appear in an exported
 * Markdown file: short lists, no reasoning and no worker output.
 *
 * @param {any} turn
 * @returns {string} empty for a turn that has neither
 */
function exportedTrace(turn) {
  let md = "";
  const tools = Array.isArray(turn.tools) ? turn.tools : [];
  if (tools.length > 0) {
    md += "**Worker calls:**\n\n";
    for (const tool of tools.slice(0, EXPORT_LIST_ITEMS)) {
      const secs = typeof tool.elapsedMs === "number" ? `, ${(tool.elapsedMs / 1000).toFixed(1)}s` : "";
      md += `- ${tool.role || tool.name || "worker"} (${outcomeWord(tool)}${secs}): ${clip(oneLine(tool.task), REPLAY_TASK_CHARS, "head")}\n`;
    }
    if (tools.length > EXPORT_LIST_ITEMS) md += `- ... and ${tools.length - EXPORT_LIST_ITEMS} more\n`;
    md += "\n";
  }
  const files = Array.isArray(turn.diffPaths) ? turn.diffPaths : [];
  if (files.length > 0) {
    md += `**Files changed:** ${files.slice(0, EXPORT_LIST_ITEMS).map((f) => `\`${f}\``).join(", ")}`;
    md += files.length > EXPORT_LIST_ITEMS ? `, and ${files.length - EXPORT_LIST_ITEMS} more\n\n` : "\n\n";
  }
  if (turn.replayed) md += "*This turn moved the chat to another lead model; the earlier turns were replayed into its context.*\n\n";
  return md;
}

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
    /**
     * The safety mode the current client was built with.
     * @type {string|null}
     */
    this._clientSafetyMode = null;
    this.needsReconnect = false;
    this.busy = false;
    this.closed = false;
    /** @type {{ done: Promise<any>, interrupt: (reason?: string) => void } | null} */
    this.activeTurn = null;
    /** @type {{ id: string, transcript: string[], trace: TurnTrace } | null} */
    this._turn = null;
    /** The next prompt carries the chat's earlier turns: the lead provider changed under them. */
    this._replayPending = false;
    /**
     * The profile text (core/profile.js) that has reached this conversation in front of a prompt, for a
     * lead with no system prompt of its own; null when none has. Memory only: a restart sends it again once.
     * @type {string|null}
     */
    this._profileSent = null;
    this.tools = new ToolTracker();
    /** @type {Map<string, LiveLogTailer>} */
    this._tailers = new Map();
    /** @type {Map<string, { kind: "write"|"orchestrator", paths?: string[], resolve: (approved: boolean, reason?: string) => void }>} */
    this.pendingApprovals = new Map();
    /** @type {Set<string>} bridge approval files already asked about */
    this._seenApprovalFiles = new Set();
    /** @type {NodeJS.Timeout|null} */
    this._approvalTimer = null;
    /** @type {EngineIpcServer|null} */
    this.ipc = null;
    /** @type {Promise<void>|null} */
    this._ready = null;
    /** @type {Promise<void>|null} */
    this._stopping = null;

    // A hand-edited `quotaPollMs` outside what `kumo config set` takes falls back to the default:
    // past setInterval's limit Node would fire it every millisecond.
    const pollMs = Number(loadConfig().quotaPollMs);
    this.quotas = new QuotaMonitor({
      getClient: () => this.client,
      getSettings: () => this.settings,
      useCache: opts.quotas !== false,
      ...(Number.isFinite(pollMs) && pollMs >= 10000 && pollMs <= 3600000 ? { pollMs } : {}),
    });
    this.quotas.on("updated", (snapshot) => {
      // A refresh in flight when the session stopped must not report after `session.closed`.
      if (!this.closed) this._emit("quota.updated", snapshot);
    });
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
    if (this.closed) return;
    let threadId = null;
    if (this.persist) {
      this.store.registerProject(this.workspace);
      let chat = this.chatId ? this._chatRecord(this.chatId) : null;
      if (!chat) {
        chat = this._findEmptyChat();
      }
      if (chat) {
        this.chatId = chat.id;
        this.turnCount = chat.turns || 0;
        threadId = chat.provider === this.settings.orchestratorProvider ? chat.threadId || null : null;
        // Another provider cannot resume that thread: it gets the earlier turns in its first prompt.
        if (this.turnCount > 0 && chat.provider !== this.settings.orchestratorProvider) this._armReplay(this.turnCount);
      } else {
        this.chatId = this._newChatRecord();
      }
    }
    if (this.useIpc) await this._openIpc();
    // stop() ran while the endpoint opened; _openIpc has already closed it.
    if (this.closed) return;
    if (this._runQuotas) this.quotas.start();

    let resumed = false;
    try {
      ({ resumed } = await this._connect({ threadId }));
    } catch (err) {
      // stop() cut the connect short; that is not a failure to report.
      if (this.closed) return;
      throw err;
    } finally {
      if (!this.closed) {
        this._emit("session.ready", {
          workspace: this.workspace,
          chatId: this.chatId,
          resumed,
          settings: { ...this.settings },
        });
      }
    }
    // Stopped by a `session.ready` listener, say: no provider is queried for a closed session.
    if (this._runQuotas && !this.closed) void this.quotas.refresh();
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
    } catch (err) {
      await server.close();
      // Without it the bridge falls back to files; nothing else is lost.
      if (!this.closed) {
        this._warn(`Could not open the engine endpoint (${err instanceof Error ? err.message : err}); using file-based worker updates.`);
      }
      return;
    }
    // stop() ran while the endpoint opened and found nothing to close.
    if (this.closed) {
      await server.close();
      return;
    }
    this.ipc = server;
  }

  /**
   * Replace the orchestrator client and open a thread on it.
   *
   * @param {{ threadId?: string | null }} [opts]
   * @returns {Promise<{ resumed: boolean, resumeFailed: boolean }>} see _openThread
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
    // After every await below: stop() may have run, and a client started now would outlive the session.
    this._assertOpen();
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
      // An operator's KUMO_SAFETY_MODE holds the lead's own tools as it holds the bridge's.
      safetyMode: process.env.KUMO_SAFETY_MODE ? stricterSafetyMode(this.settings.safetyMode, process.env.KUMO_SAFETY_MODE) : this.settings.safetyMode,
      workspace: this.workspace,
      config: { ...loadConfig(), ...this.settings },
      env: this._clientEnv(),
    });
    this.client = client;
    this._clientSafetyMode = this.settings.safetyMode;
    this._attach(client);
    try {
      await client.start();
      this._assertOpen();
      const opened = await this._openThread({ threadId });
      this._assertOpen();
      // A thread that is not the one the lead had has not seen the profile.
      if (!opened.resumed) this._profileSent = null;
      // This chat's thread would not come back: the new one has not seen its earlier turns.
      if (opened.resumeFailed && this.turnCount > 0 && !this._replayPending) this._armReplay(this.turnCount);
      return opened;
    } catch (err) {
      // A client with no thread fails every later prompt with "No active
      // thread"; the next prompt retries the whole start instead.
      this.needsReconnect = true;
      // stop() stops the client it found; this one may have been started after.
      if (this.closed) {
        try {
          await client.stop();
        } catch {}
      }
      throw err;
    }
  }

  /**
   * Whether the client was built for another safety mode than the session has
   * now. It matters for the leads in TIER_BOUND_LEADS: they fix the permissions
   * of their own tools (skipping them, or not) from the mode they were built
   * with. The bridge reads the tier from the session on every worker call, so
   * that holds for every lead's worker calls; it cannot reach a lead's own tools.
   */
  _clientTierStale() {
    return TIER_BOUND_LEADS.has(this.settings.orchestratorProvider) && this._clientSafetyMode !== this.settings.safetyMode;
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
   * @returns {Promise<{ resumed: boolean, resumeFailed: boolean }>} whether the thread was resumed, and whether
   *   resuming was tried and failed (the new thread has not seen the conversation)
   */
  async _openThread({ threadId = null }) {
    const client = this.client;
    const opts = {
      workspace: this.workspace,
      model: this.settings.orchestratorModel,
      reasoningEffort: this.settings.reasoningEffort,
    };
    let resumed = false;
    let resumeFailed = false;
    if (threadId && typeof client.resumeThread === "function") {
      try {
        await client.resumeThread({ ...opts, threadId });
        resumed = true;
      } catch (err) {
        resumeFailed = true;
        this._warn(`Could not resume the earlier conversation (${err instanceof Error ? err.message : err}); starting a new one.`);
      }
    }
    if (!resumed) {
      await client.startThread(opts);
    }
    if (client.model && client.model !== this.settings.orchestratorModel) {
      this.settings.orchestratorModel = client.model;
      this._emit("settings.changed", { settings: { ...this.settings }, changed: ["orchestratorModel"] });
    }
    return { resumed, resumeFailed };
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
      this._turn.trace.addReasoning(text || "");
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
    const trace = new TurnTrace();
    this._turn = { id: turnId, transcript, trace };
    // The prompt shown and recorded is the user's own; a replay and the profile go in front of it only on its way to the lead.
    this._emit("turn.started", { turnId, prompt });

    /** @type {{ ok: boolean, reason?: string, timedOut?: boolean, interrupted?: boolean }} */
    let outcome;
    let replayed = false;
    /** @type {string|null} the profile text this turn's prompt carries to the lead */
    let profileCarried = null;
    try {
      // Read now, so a change in Settings applies from this turn with no restart.
      const profile = profileText(loadConfig());
      // A failed background start is retried here rather than surfacing twice.
      await this.start().catch(() => {});
      if (this.needsReconnect || !this.client || this._clientTierStale()) {
        this._notice("Starting the orchestrator...");
        await this._connect({ threadId: this._chatThreadId() });
      }
      this._refreshProjectConfigs();
      if (this.interactive && this.settings.safetyMode === "interactive") this._startApprovalWatcher();

      // Built after the start: opening the chat may have armed the replay.
      const preamble = this._replayPending ? this._takeReplayPreamble() : null;
      replayed = preamble !== null;

      const client = this.client;
      // A lead with a system prompt per turn takes the profile there. Any other gets it in front of the
      // prompt, once for the conversation and again when the text changes.
      if (typeof client.setProfile === "function") client.setProfile(profile);
      else if (profile !== "" && profile !== this._profileSent) profileCarried = profile;
      /** @type {string[]} */
      const front = [];
      if (preamble !== null) front.push(preamble, "");
      if (profileCarried !== null) front.push(profilePreamble(profileCarried), "");
      const sent = [...front, prompt].join("\n");

      this.activeTurn = runTurn(
        client,
        () => client.startTurn(sent, { model: this.settings.orchestratorModel, effort: this.settings.reasoningEffort }),
        { timeoutMs: this.settings.turnTimeoutMs }
      );
      outcome = await this.activeTurn.done;
    } catch (err) {
      outcome = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      this.activeTurn = null;
      // Before the turn is forgotten: a log tailer's last output and the end of unfinished calls belong to it.
      this._finishTurnTools();
      this._turn = null;
      this._stopApprovalWatcher();
      this._settleApprovals("all", null, "the turn ended");
      this.busy = false;
    }

    const elapsedMs = Date.now() - startedAt;
    const text = transcript.join("");
    if (outcome.ok) {
      this._recordTurn(prompt, text, elapsedMs, { trace, replayed });
      // The context reached the lead and the turn is saved; a failed turn leaves it pending for the next prompt.
      if (replayed) this._replayPending = false;
      if (profileCarried !== null) this._profileSent = profileCarried;
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
    if (this._runQuotas && !this.closed) void this.quotas.refresh();
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
   * Save a finished turn: what was asked and answered, which provider and
   * model answered, and its trace (reasoning, worker calls, changed files).
   * Only a successful turn is saved; a failed or interrupted one leaves no record.
   *
   * @param {string} prompt
   * @param {string} text
   * @param {number} elapsedMs
   * @param {{ trace: TurnTrace, replayed: boolean }} extra
   */
  _recordTurn(prompt, text, elapsedMs, { trace, replayed }) {
    if (!this.persist || !this.chatId) return;
    this.turnCount++;
    this.store.appendTurn(this.workspace, this.chatId, {
      prompt,
      responseSummary: text || null,
      timestamp: Date.now(),
      model: this.settings.orchestratorModel,
      provider: this.settings.orchestratorProvider,
      elapsedMs,
      ...trace.snapshot(),
      ...(replayed ? { replayed: true } : {}),
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
    this._turn?.trace.toolStarted(call);
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
      if (held) this._emitToolOutput(call.id, held);
    } else if (!this.ipc || this.ipc.connectedBridges === 0) {
      // No bridge reached the engine: follow its live-log file instead.
      const tailer = new LiveLogTailer({
        workspace: this.workspace,
        toolId: call.id,
        onText: (text) => this._emitToolOutput(call.id, text),
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
    this._emitToolCompleted(call, !(item?.status === "failed" || item?.error));
  }

  /**
   * Report a worker call's output, and keep its end for the turn's record.
   *
   * @param {string} toolId
   * @param {string} text
   */
  _emitToolOutput(toolId, text) {
    this._turn?.trace.toolOutput(toolId, text);
    this._emit("tool.output", { toolId, text });
  }

  /**
   * Report a worker call's end, and note it for the turn's record.
   *
   * @param {import("./tool-tracker.js").ToolCall} call
   * @param {boolean} ok
   */
  _emitToolCompleted(call, ok) {
    const elapsedMs = Date.now() - call.startedAt;
    this._turn?.trace.toolCompleted(call.id, { ok, elapsedMs });
    this._emit("tool.completed", { toolId: call.id, name: call.name, ok, elapsedMs });
  }

  /** @param {{ runId?: string, tool?: string, task?: string }} params */
  _onRunStarted({ runId, tool, task }) {
    if (!runId) return;
    const call = this.tools.attachRun({ runId, tool: String(tool || ""), task: String(task || "") });
    if (!call) return;
    this._stopTailer(call.id);
    const held = this.tools.takeHeldOutput(runId);
    if (held) this._emitToolOutput(call.id, held);
  }

  /** @param {{ runId?: string, text?: string }} params */
  _onRunOutput({ runId, text }) {
    if (!runId || !text) return;
    const routed = this.tools.outputFor(runId, String(text));
    if (routed) this._emitToolOutput(routed.call.id, routed.text);
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
      this._emitToolCompleted(call, false);
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
        paths: diffPathsOf(String(previewText || "")),
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
    // What the operator approved is what the turn changed (as far as the engine sees: see diffPathsOf).
    if (approved && pending.paths?.length) this._turn?.trace.addDiffPaths(pending.paths);
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
        paths: diffPathsOf(String(record?.previewText || "")),
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

  _findEmptyChat() {
    if (!this.persist) return null;
    const chats = this.store.listChats(this.workspace);
    return (
      chats.find((c) => {
        if ((c.turns || 0) > 0) return false;
        const turns = this.store.loadTurnLog(this.workspace, c.id);
        return turns.length === 0;
      }) || null
    );
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

  /**
   * The chat's earlier turns must reach a lead that has not seen them: the
   * next prompt carries them, and the turn that does is recorded as replayed.
   *
   * @param {number} turns how many earlier turns the chat has
   */
  _armReplay(turns) {
    this._replayPending = true;
    const lead = providerDisplayName(this.settings.orchestratorProvider);
    const earlier = turns === 1 ? "its 1 earlier turn goes" : `its ${turns} earlier turns go`;
    this._notice(`Continuing this chat on ${lead}: ${earlier} into the new model's context.`);
  }

  /**
   * The text for the pending replay, from the chat's turn log. With nothing to
   * carry over (the log is gone) there is nothing pending any more.
   *
   * @returns {string|null}
   */
  _takeReplayPreamble() {
    const turns = this.chatId ? this.store.loadTurnLog(this.workspace, this.chatId) : [];
    const preamble = replayPreamble(turns);
    if (preamble === null) this._replayPending = false;
    return preamble;
  }

  _assertOpen() {
    if (this.closed) throw new Error("This session is closed.");
  }

  _assertIdle() {
    this._assertOpen();
    if (this.busy) throw new Error("A turn is running; wait for it or interrupt it first.");
  }

  async _ensureClient() {
    await this.start().catch(() => {});
    if (this.needsReconnect || !this.client) await this._connect({});
  }

  _saveChatState() {
    if (this.persist && this.chatId) {
      this.store.updateChat(this.workspace, this.chatId, { turns: this.turnCount });
    }
  }

  /** Start a fresh conversation (or navigate to an existing empty chat). */
  async newChat() {
    this._assertIdle();
    this._saveChatState();
    // If the current chat has 0 turns and an empty log, keep using it.
    if (this.chatId && this.turnCount === 0 && this.store.loadTurnLog(this.workspace, this.chatId).length === 0) {
      await this._ensureClient();
      this._emit("chat.changed", { workspace: this.workspace, chatId: this.chatId, title: "New Chat", resumed: false });
      return;
    }
    // If an empty chat exists elsewhere in this workspace, navigate to it instead of making another.
    const empty = this._findEmptyChat();
    if (empty) {
      await this.openChat(empty.id);
      return;
    }
    await this._ensureClient();
    await this._openThread({});
    this.chatId = this.persist ? this._newChatRecord() : null;
    this.turnCount = 0;
    this._replayPending = false;
    // A new thread has not seen the profile.
    this._profileSent = null;
    this._emit("chat.changed", { workspace: this.workspace, chatId: this.chatId, title: "New Chat", resumed: false });
  }

  /**
   * Switch to an earlier chat of this workspace, resuming its provider thread
   * when the provider supports it (Codex, Claude Code, Antigravity). A chat
   * made on another provider cannot be resumed there: its earlier turns go
   * into the first prompt instead (`replayed`).
   *
   * @param {string} chatId
   * @returns {Promise<{ resumed: boolean, hadTurns: boolean, replayed: boolean }>}
   */
  async openChat(chatId) {
    this._assertIdle();
    const chat = this._chatRecord(chatId);
    if (!chat) throw new Error(`No chat '${chatId}' in this workspace.`);
    this._saveChatState();
    await this._ensureClient();
    const sameProvider = chat.provider === this.settings.orchestratorProvider;
    const { resumed, resumeFailed } = await this._openThread({ threadId: sameProvider ? chat.threadId || null : null });
    this.chatId = chat.id;
    this.turnCount = chat.turns || 0;
    // Whatever was pending belonged to the chat that was open, and the profile reached that chat's thread, not this one.
    this._replayPending = false;
    this._profileSent = null;
    this._emit("chat.changed", { workspace: this.workspace, chatId: chat.id, title: chat.title || "Chat", resumed });
    const hadTurns = this.turnCount > 0;
    // Its thread is gone or on another provider: the lead has not seen these turns.
    const replayed = hadTurns && (!sameProvider || resumeFailed);
    if (replayed) this._armReplay(this.turnCount);
    return { resumed, hadTurns, replayed };
  }

  /**
   * Move the session to another workspace, opening a specified chat, reusing an empty one, or creating a fresh one.
   *
   * @param {string} dir
   * @param {{ chatId?: string }} [opts]
   */
  async setWorkspace(dir, { chatId } = {}) {
    this._assertIdle();
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) throw new Error(`Directory not found: ${resolved}`);
    this._saveChatState();
    this.workspace = resolved;
    // Whatever was pending belonged to the chat that was open; the chat chosen below may arm its own.
    this._replayPending = false;
    this._profileSent = null;
    let targetChat = null;
    let threadId = null;
    if (this.persist) {
      this.store.registerProject(resolved);
      if (chatId) {
        targetChat = this._chatRecord(chatId);
      }
      if (!targetChat) {
        targetChat = this._findEmptyChat();
      }
      if (targetChat) {
        this.chatId = targetChat.id;
        this.turnCount = targetChat.turns || 0;
        threadId = targetChat.provider === this.settings.orchestratorProvider ? targetChat.threadId || null : null;
        if (this.turnCount > 0 && targetChat.provider !== this.settings.orchestratorProvider) {
          this._armReplay(this.turnCount);
        }
      } else {
        this.chatId = this._newChatRecord();
        this.turnCount = 0;
      }
    } else {
      this.chatId = null;
      this.turnCount = 0;
    }
    // The bridge is started for one workspace and the client env names it.
    const { resumed } = await this._connect({ threadId });
    this._emit("chat.changed", {
      workspace: resolved,
      chatId: this.chatId,
      title: targetChat?.title || "New Chat",
      resumed,
    });
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
   * The export folder as a clean relative path, or "" for the workspace itself.
   * It comes from the user's preferences, so it is checked here as well as by exportTarget.
   *
   * @param {unknown} dir
   * @returns {string}
   */
  _exportFolder(dir) {
    if (dir === undefined || dir === null) return "";
    if (typeof dir !== "string") throw new Error("The export folder must be a path.");
    const folder = dir.trim();
    if (!folder) return "";
    if (path.isAbsolute(folder)) throw new Error(`'${dir}' is not a workspace-relative folder.`);
    if (process.platform === "win32" && folder.split(/[\\/]/).some((part) => WINDOWS_DEVICE_NAME.test(part.split(".")[0].trimEnd()))) {
      throw new Error(`'${dir}' names a Windows device; export to another folder.`);
    }
    return folder;
  }

  /**
   * Write the chat as Markdown into the workspace.
   *
   * @param {string} [filename]
   * @param {{ dir?: string | null }} [opts] `dir`: a workspace-relative folder to write into, made when missing
   *   (the folder the user chose in their preferences); the file is judged by exportTarget either way
   * @returns {string} the file written
   */
  exportMarkdown(filename, { dir } = {}) {
    const log = this.turnLog();
    if (log.length === 0) throw new Error("No turns to save in the current conversation.");
    const name = filename || `kumo-session-${new Date().toISOString().slice(0, 10)}.md`;
    const folder = this._exportFolder(dir);
    const out = exportTarget(this.workspace, folder ? path.join(folder, name) : name);
    // Only a path that passed the checks above may be created.
    if (folder) fs.mkdirSync(path.dirname(out), { recursive: true });
    const s = this.settings;
    let md = `# Kumo Session — ${new Date().toLocaleDateString()}\n\n`;
    md += `**Workspace:** ${this.workspace}\n\n`;
    md += `**Orchestrator:** ${s.orchestratorModel}-${s.reasoningEffort} (${s.orchestratorProvider})\n\n`;
    md += `**Worker:** ${s.workerModel}-${s.workerEffort} (${s.workerProvider})\n\n---\n\n`;
    log.forEach((turn, i) => {
      md += `## Turn ${i + 1} (${new Date(turn.timestamp).toLocaleTimeString()})\n\n`;
      md += `**Prompt:**\n\n${turn.prompt}\n\n`;
      if (turn.responseSummary) md += `**Response:**\n\n${turn.responseSummary}\n\n`;
      md += exportedTrace(turn);
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
   * All or nothing: when the orchestrator cannot follow (a provider that will
   * not start), the session keeps its earlier settings, nothing is saved and
   * the error is thrown. `settings.changed` is emitted either way, carrying
   * the settings the session really has.
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
    const tierChanged = changed.includes("safetyMode") && TIER_BOUND_LEADS.has(next.orchestratorProvider);
    // Taken now: connecting may correct the model, and the saved default is what the user asked for.
    const saved = changed.map((key) => /** @type {[string, unknown]} */ ([key, /** @type {Record<string, unknown>} */ (next)[key]]));
    const previous = this.settings;
    const replayWas = this._replayPending;
    const profileWas = this._profileSent;
    this.settings = next;
    let applied = false;
    try {
      if (changed.includes("orchestratorProvider")) {
        this.quotas.providerChanged();
        if (this.client || this._ready) await this._connect({});
        // The new provider starts an empty thread, so the chat's earlier turns ride along with the next prompt.
        // Armed once the provider is up: if it cannot start, the chat stays on the one it had.
        if (this.persist && this.chatId && this.turnCount > 0) this._armReplay(this.turnCount);
      } else if ((toolsChanged || tierChanged) && this.client) {
        // A running turn keeps its tools and its permissions; the next one starts on the new ones.
        if (this.busy) {
          this.needsReconnect = true;
          if (tierChanged) this._notice(`${providerDisplayName(next.orchestratorProvider)} applies the new safety mode from the next turn.`);
        } else {
          await this._connect({ threadId: this._clientThreadId() });
        }
      } else if (changed.includes("orchestratorModel") || changed.includes("reasoningEffort")) {
        await this.client?.applyModel?.({ model: next.orchestratorModel, reasoningEffort: next.reasoningEffort });
      }
      applied = true;
      // Saved last: a provider that cannot start must not become the default.
      if (persist) for (const [key, value] of saved) setConfigValue(key, value);
    } catch (err) {
      if (!applied) {
        // The session could not follow the change, so it stays as it was.
        this.settings = previous;
        this._replayPending = replayWas;
        this._profileSent = profileWas;
        if (changed.includes("orchestratorProvider")) this.quotas.providerChanged();
      }
      throw err;
    } finally {
      // Whatever happened, a listener learns the settings the session really has.
      if (!this.closed) this._emit("settings.changed", { settings: { ...this.settings }, changed: applied ? changed : [] });
    }
    if (!changed.includes("orchestratorProvider") && (changed.includes("workerProvider") || changed.includes("roles"))) {
      this.quotas.providerChanged();
    }
    return changed;
  }

  // ── quotas ──

  /** Fetch fresh quota figures now across all subscriptions (an explicit /status, /refresh, or startup probe). */
  async refreshQuotas() {
    // probeAll reports through the monitor's `updated` event, which becomes `quota.updated` (and not after close).
    return this.quotas.probeAll();
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

  /**
   * Stop everything this session started. Every call returns the same
   * promise, which settles once nothing of the session is left running.
   *
   * @returns {Promise<void>}
   */
  stop() {
    if (!this._stopping) this._stopping = this._teardown();
    return this._stopping;
  }

  async _teardown() {
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
    // A start still in flight sees `closed` after its current step and releases
    // what that step made. Wait for it, so no endpoint, client or timer survives
    // this call and `session.ready` never follows `session.closed`.
    await this._ready?.catch(() => {});
    if (this.ipc) {
      await this.ipc.close();
      this.ipc = null;
    }
    this._emit("session.closed", {});
  }
}
