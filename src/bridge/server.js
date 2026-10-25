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
 * server.js — MCP stdio bridge server with dynamic workspace support.
 *
 * Exposes one tool per worker role to any MCP-capable orchestrator — scout
 * (`worker_explore`), builder (`worker_implement`), tester (`worker_test`),
 * researcher (`worker_research`), reviewer (`worker_review`), designer
 * (`worker_design`) and each custom role (`worker_<id>`) — and routes every
 * call to the model assigned to that role, on one of the 13 supported worker
 * providers: subscription CLIs (Antigravity, Codex, Claude Code, OpenCode,
 * CommandCode, Copilot, Cursor, Gemini CLI, Ollama) or direct HTTP APIs
 * (openai/anthropic/gemini/compat). A role with no assignment runs on the
 * shared worker (`workerProvider` / `workerModel` / `workerEffort`).
 *
 * The tool list is built in startServer() from the session's settings, and
 * each description names the role's model, so the lead can route by the
 * actual assignment.
 *
 * The target workspace comes from `--workspace <path>`, else `KUMO_WORKSPACE`,
 * else the legacy `ORCHESTRATOR_WORKSPACE`, else the process working directory.
 *
 * When the orchestrator was started by a Kumo session, its environment names
 * the session's engine endpoint (KUMO_ENGINE_ENDPOINT + KUMO_SESSION_TOKEN).
 * The bridge then takes its settings from that session, streams each run's
 * output tagged with its run id, and asks the session for approvals. Without
 * one it falls back to the saved config, live-log files and approval files.
 */

import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getWorker, workerCapabilities, KNOWN_WORKERS } from "../providers/workers/registry.js";
import { getSystemPrompt } from "./prompts.js";
import { loadConfig, detectProviderForModel, canonicalizeProvider } from "../config/settings.js";
import { EFFORT_LEVELS } from "../config/models.js";
import { listRoles, findRole, resolveRoleTarget, describeTarget } from "../config/roles.js";
import {
  getLiveLogPath,
  setActiveLiveRun,
  clearActiveLiveRun,
  getApprovalDir,
} from "../data/sessions.js";
import { atomicWriteJson } from "../config/paths.js";
import { VERSION } from "../version.js";
import { routeLiveOutput } from "../utils/process.js";
import { connectEngine } from "../core/ipc/engine-client.js";
import { StringDecoder } from "node:string_decoder";

// Parse CLI flags
let workspaceDir = process.env.KUMO_WORKSPACE || process.env.ORCHESTRATOR_WORKSPACE || process.cwd();
let modelOverride = process.env.GEMINI_MODEL || null;
let effortOverride = null;
let safetyModeOverride = process.env.KUMO_SAFETY_MODE || null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace" && args[i + 1]) {
    workspaceDir = args[i + 1];
    i++;
  } else if (args[i] === "--model" && args[i + 1]) {
    modelOverride = args[i + 1];
    i++;
  } else if (args[i] === "--effort" && args[i + 1]) {
    effortOverride = args[i + 1];
    i++;
  } else if (args[i] === "--safety-mode" && args[i + 1]) {
    safetyModeOverride = args[i + 1];
    i++;
  }
}

/**
 * Set in the environment of every worker this bridge spawns, and therefore of
 * any MCP server that worker starts. A worker CLI that has `kumo-bridge`
 * registered globally (e.g. `agy mcp add`, or ~/.codex/config.toml) would
 * otherwise call back into Kumo — and with write permission, recursively
 * spawn worker after worker.
 */
export const NESTED_ENV = "KUMO_INSIDE_WORKER";
const nestedInWorker = process.env[NESTED_ENV] === "1";

/**
 * The session this bridge works for, once connected (see startServer).
 * @type {import("../core/ipc/engine-client.js").EngineConnection | null}
 */
let engine = null;

/** Test seam: attach (or detach, with null) an engine connection. */
export function setEngineConnection(connection) {
  engine = connection;
}

/**
 * The settings for this call: the session's own when an engine is
 * connected, else the saved config. The session's win, so a worker or
 * safety-mode switch in one window no longer changes another window's turn.
 */
async function effectiveConfig() {
  const config = loadConfig();
  if (!engine || engine.closed) return config;
  try {
    const session = await engine.request("settings.get");
    return { ...config, ...session };
  } catch {
    return config;
  }
}

export const PREVIEW_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL

// In-memory cache for pending diff previews: Map<string, { previewText, taskHash, safetyMode, workspaceDir, createdAt }>
export const pendingPreviews = new Map();

/**
 * Hash a task string for preview binding.
 *
 * @param {string} task
 * @returns {string}
 */
export function hashTask(task) {
  return crypto.createHash("sha256").update(task || "").digest("hex");
}

/**
 * Clean up expired previews from cache.
 */
export function pruneExpiredPreviews() {
  const now = Date.now();
  for (const [id, entry] of pendingPreviews.entries()) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) {
      pendingPreviews.delete(id);
    }
  }
}

/**
 * Register a new diff preview and return its unique previewId token.
 */
export const MAX_PENDING_PREVIEWS = 100;

export function storePendingPreview(previewText, opts = {}) {
  pruneExpiredPreviews();
  // Map iterates in insertion order, so the first key is the oldest entry.
  while (pendingPreviews.size >= MAX_PENDING_PREVIEWS) {
    pendingPreviews.delete(pendingPreviews.keys().next().value);
  }
  const previewId = `prev_${crypto.randomUUID()}`;
  pendingPreviews.set(previewId, {
    previewText,
    taskHash: opts.taskHash || null,
    safetyMode: opts.safetyMode || null,
    workspaceDir: opts.workspaceDir || null,
    createdAt: Date.now(),
  });
  return previewId;
}

/**
 * Look up a pending preview without consuming it. Validation happens before the
 * worker runs; deleting there makes a crashed or timed-out apply unretryable,
 * because the previewId is already gone.
 */
export function peekPendingPreview(previewId) {
  pruneExpiredPreviews();
  if (!previewId || !pendingPreviews.has(previewId)) return null;
  return pendingPreviews.get(previewId);
}

/**
 * Retrieve and consume a pending preview by previewId (single-use, no fallback).
 */
export function consumePendingPreview(previewId) {
  pruneExpiredPreviews();
  if (!previewId || !pendingPreviews.has(previewId)) return null;
  const entry = pendingPreviews.get(previewId);
  pendingPreviews.delete(previewId);
  return entry;
}

/**
 * Run git and return stdout, or "" when git fails (not a repo, no HEAD, …).
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function git(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

/**
 * Capture current git porcelain status (modified and untracked files).
 *
 * `--untracked-files=all` lists every file inside an untracked directory —
 * the default collapses it to `dir/`, whose content hash is null both before
 * and after a worker writes into it, so those edits went unreported. `-z`
 * yields raw paths: no C-style quoting of spaces or non-ASCII names.
 */
export function getGitStatus(cwd) {
  const out = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!out) return [];
  const tokens = out.split("\0");
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push(entry.slice(3));
    // In -z mode a rename/copy is followed by its original path as its own token.
    if (status.includes("R") || status.includes("C")) i++;
  }
  return files;
}

/**
 * Capture git diff stat summary.
 */
export function getGitDiffStat(cwd) {
  return git(cwd, ["diff", "HEAD", "--stat"]).trim();
}

/**
 * Capture the names of tracked files with uncommitted modifications.
 */
export function getGitDiffNames(cwd) {
  return git(cwd, ["diff", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean);
}

function hashFileContent(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Snapshot every dirty path plus its content hash.
 *
 * Comparing only the *set* of dirty paths misses every file that was already
 * dirty before the worker ran, which then gets reported as "previewed but not
 * modified". The content hash is what actually discriminates.
 *
 * @param {string} cwd
 * @returns {{ files: string[], hashes: Map<string, string|null> }}
 */
export function captureWorkspaceState(cwd) {
  const files = Array.from(new Set([...getGitStatus(cwd), ...getGitDiffNames(cwd)]));
  const hashes = new Map();
  // With every untracked file listed, an un-ignored dependency tree could mean
  // hashing tens of thousands of files twice per write; past the cap, files are
  // listed but not hashed, so only a path appearing or vanishing shows up.
  for (const f of files.slice(0, MAX_SNAPSHOT_HASHES)) {
    hashes.set(f, hashFileContent(path.join(cwd, f)));
  }
  return { files, hashes };
}

/** How many dirty files a workspace snapshot hashes. */
export const MAX_SNAPSHOT_HASHES = 5000;

/**
 * Files whose content differs between two workspace snapshots.
 *
 * A deletion still shows up in `git status --porcelain`, so it lands in
 * `post.files` with a null hash and is reported here as well.
 *
 * @param {{files: string[], hashes: Map<string, string|null>}} pre
 * @param {{files: string[], hashes: Map<string, string|null>}} post
 * @returns {string[]}
 */
export function changedFilesBetween(pre, post) {
  const before = new Set(pre.files);
  const changed = [];
  for (const f of post.files) {
    if (!before.has(f)) {
      changed.push(f); // newly dirty
    } else if (pre.hashes.has(f) && post.hashes.has(f) && pre.hashes.get(f) !== post.hashes.get(f)) {
      changed.push(f); // was dirty, content changed
    }
    // Dirty in both snapshots but past the hashing cap: no evidence either way.
  }
  return changed;
}

/**
 * The `---`/`+++` header paths of a unified diff, exactly as written (prefix
 * included, trailing tab/timestamp removed, /dev/null skipped). Only a `---`
 * line directly followed by a `+++` line counts, so prose and Markdown rules
 * are not mistaken for headers.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function diffHeaderPaths(text) {
  const lines = String(text || "").split(/\r?\n/);
  const paths = [];
  const pathOf = (line) => line.slice(4).split("\t")[0].trim().replace(/^"(.*)"$/, "$1");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].startsWith("--- ") || !lines[i + 1].startsWith("+++ ")) continue;
    for (const p of [pathOf(lines[i]), pathOf(lines[i + 1])]) {
      if (p && p !== "/dev/null") paths.push(p);
    }
    i++;
  }
  return paths;
}

/**
 * How many leading path components `git apply` must strip: 1 when every header
 * uses git's `a/` `b/` prefixes, otherwise 0. Applying an unprefixed diff with
 * git's default `-p1` drops the first real directory (`src/index.js` became
 * `index.js`).
 *
 * @param {string[]} headerPaths
 * @returns {0|1}
 */
export function diffStripLevel(headerPaths) {
  return headerPaths.length > 0 && headerPaths.every((p) => /^[ab]\//.test(p)) ? 1 : 0;
}

/**
 * Extract target file paths mentioned in a unified diff or file header preview.
 */
export function extractPreviewFiles(previewText) {
  if (!previewText) return [];
  const files = new Set();
  const headers = diffHeaderPaths(previewText);
  const level = diffStripLevel(headers);
  for (const p of headers) {
    files.add(level === 1 ? p.slice(2) : p);
  }
  let match;
  const fileHeaderRegex = /(?:\[FILE:\s*|\bFile:\s*|\bmodified:\s*)([^\s\],]+)/gi;
  while ((match = fileHeaderRegex.exec(previewText)) !== null) {
    if (!match[1]) continue;
    const candidate = match[1].replace(/[.,"' :;)]+$/g, "");
    // Prose such as "modified: several functions" must not yield the file `several`.
    if (!/[\\/]/.test(candidate) && !/\.[A-Za-z0-9]{1,10}$/.test(candidate)) continue;
    files.add(candidate);
  }
  return Array.from(files).filter(Boolean);
}

/**
 * Sanity-check actual modified files against what was previewed in Phase 1.
 */
export function checkDiffFidelity(previewText, actualModifiedFiles) {
  const previewFiles = extractPreviewFiles(previewText);
  if (previewFiles.length === 0) {
    return "[WARNING] preview contained no parseable file paths; fidelity unverifiable.";
  }
  if (!actualModifiedFiles || actualModifiedFiles.length === 0) {
    return "[WARNING] worker reported no file changes despite a non-empty preview.";
  }

  const norm = (p) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const match = (a, b) => {
    const na = norm(a);
    const nb = norm(b);
    return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`);
  };

  const unexpectedFiles = actualModifiedFiles.filter(
    (af) => !previewFiles.some((pf) => match(pf, af))
  );
  const missingFiles = previewFiles.filter(
    (pf) => !actualModifiedFiles.some((af) => match(pf, af))
  );

  if (unexpectedFiles.length > 0 || missingFiles.length > 0) {
    const notes = [];
    if (unexpectedFiles.length > 0) {
      notes.push(`Unexpected files modified: ${unexpectedFiles.join(", ")}`);
    }
    if (missingFiles.length > 0) {
      notes.push(`Previewed files that were not modified: ${missingFiles.join(", ")}`);
    }
    return `\n\n[NOTE: Preview and applied changes diverge; review carefully!]\n- ${notes.join("\n- ")}`;
  }

  return null;
}

function formatResult(result, toolName) {
  if (result.refused) {
    return {
      content: [{ type: "text", text: `[REFUSED] ${toolName}: ${result.stderr}` }],
      isError: true,
    };
  }

  if (result.timedOut) {
    return {
      content: [
        {
          type: "text",
          text: `[TIMEOUT] ${toolName} exceeded execution time limit.\n\nPartial output:\n${result.stdout || "(none)"}`,
        },
      ],
      isError: true,
    };
  }

  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: `[ERROR] ${toolName} failed (exit code ${result.code}).\n\nstderr:\n${result.stderr || "(none)"}\n\nstdout:\n${result.stdout || "(none)"}`,
        },
      ],
      isError: true,
    };
  }

  // A CLI can exit 0 having done nothing and explain why only on stderr (agy
  // does this when a tool needed a permission headless mode cannot grant).
  // A bare "(no output)" success hid that the worker never answered.
  const stderr = (result.stderr || "").trim();
  if (!result.stdout && stderr) {
    return {
      content: [{ type: "text", text: `[NO OUTPUT] ${toolName} produced no answer.\n\nstderr:\n${stderr}` }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: result.stdout || "(no output)",
      },
    ],
  };
}

/** A worker result for a task the bridge declined to run. */
function refusal(message) {
  return { ok: false, refused: true, code: 1, stdout: "", stderr: message, timedOut: false };
}

/** Limits on what is inlined for workers that cannot open files themselves. */
export const INLINE_MAX_FILE_BYTES = 64 * 1024;
export const INLINE_MAX_TOTAL_BYTES = 256 * 1024;

/**
 * Read the files a text-only worker (HTTP API, `ollama run`) should see.
 *
 * Those workers have no filesystem, so without this they were sent bare paths
 * and described files they never read. Only regular files inside the workspace
 * are read (symlinks are resolved first); anything else is listed with the
 * reason it was left out, so the model can say what it could not see.
 *
 * @param {string} workspace
 * @param {string[]} files
 * @returns {Array<{ path: string, content: string, truncated?: boolean }>}
 */
export function readWorkspaceFiles(workspace, files) {
  let root;
  try {
    root = fs.realpathSync(workspace);
  } catch {
    root = path.resolve(workspace);
  }
  const out = [];
  let budget = INLINE_MAX_TOTAL_BYTES;
  for (const rel of files || []) {
    const note = (content) => out.push({ path: rel, content });
    let real;
    try {
      real = fs.realpathSync(path.resolve(root, rel));
    } catch {
      note("(not found)");
      continue;
    }
    const inside = path.relative(root, real);
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      note("(outside the workspace; not read)");
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(real);
    } catch {
      note("(unreadable)");
      continue;
    }
    if (!stat.isFile()) {
      note("(not a regular file)");
      continue;
    }
    if (budget <= 0) {
      note("(not read: inline size budget exhausted)");
      continue;
    }
    const limit = Math.min(INLINE_MAX_FILE_BYTES, budget);
    let buf;
    try {
      const fd = fs.openSync(real, "r");
      try {
        buf = Buffer.alloc(Math.min(stat.size, limit));
        fs.readSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      note("(unreadable)");
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) {
      note("(binary file; not shown)");
      continue;
    }
    budget -= buf.length;
    out.push({ path: rel, content: buf.toString("utf-8"), truncated: stat.size > buf.length });
  }
  return out;
}

/**
 * Decide which worker runs a call, and with which model and effort.
 *
 * The role's own assignment (`config.roles[role]`) comes first; a role
 * without one runs on the shared worker — KUMO_WORKER_PROVIDER, else the
 * configured `workerProvider`. A per-call provider override wins over both.
 * Settings are read on every call, so a `/role` or `/model worker` switch
 * applies to the next call; a configured model and effort are only used when
 * the call runs on the provider they were configured for — handing a Gemini
 * model id to a per-call `claude` override would just make that CLI fail.
 *
 * @param {{ role?: string|null, provider?: string, model?: string, effort?: string }} opts
 * @param {object} config
 */
export function resolveWorkerTarget(opts, config) {
  const worker = {
    provider: canonicalizeProvider(
      process.env.KUMO_WORKER_PROVIDER ||
        config.workerProvider ||
        detectProviderForModel(opts.model || modelOverride || config.workerModel)
    ),
    // --model / GEMINI_MODEL / --effort override the shared worker, so they
    // follow the same rule as its config values.
    model: modelOverride || config.workerModel,
    effort: effortOverride || config.workerEffort,
  };
  return resolveRoleTarget(config, opts.role || null, opts, worker);
}

/**
 * Dispatch task to the active worker provider (subscription CLI or direct API).
 *
 * `permission` ("read" | "write") is what the worker is allowed to do; it is
 * derived from the legacy `mode` when absent. Tasks a worker cannot perform are
 * refused here rather than run and answered with invented output.
 */
export async function dispatchWorkerTask(opts) {
  if (nestedInWorker) {
    return refusal(
      "this Kumo bridge was started from inside a Kumo worker; workers cannot delegate further. Do the task directly."
    );
  }
  const config = opts.config || (await effectiveConfig());
  const workspace = opts.workspace || workspaceDir;
  const target = resolveWorkerTarget(opts, config);
  // opts.provider is model-authored, so it may only name a known worker: the id
  // becomes the executable the generic worker spawns. Operator-configured
  // fallbacks may opt into an arbitrary CLI.
  const worker = getWorker(target.provider, { allowGeneric: !target.requested });
  const caps = workerCapabilities(target.provider);
  const permission = opts.permission || (opts.mode === "workspace-write" ? "write" : "read");

  if (permission === "write" && !caps.canWrite) {
    return refusal(
      `worker provider '${target.provider}' cannot modify files. Use a CLI worker (codex, claude, antigravity, …), ` +
        `or switch to diff-review mode so Kumo can apply its proposed diff itself.`
    );
  }

  let fileContents = [];
  if (!caps.readsWorkspace) {
    if (!opts.files || opts.files.length === 0) {
      return refusal(
        `worker provider '${target.provider}' cannot open workspace files on its own. ` +
          `Pass the files it should read in \`files\`, or use a CLI worker (codex, claude, antigravity, …).`
      );
    }
    fileContents = readWorkspaceFiles(workspace, opts.files);
  }

  const systemPrompt =
    opts.systemPrompt ??
    (opts.role
      ? getSystemPrompt(opts.role, {
          config,
          model: target.model,
          effort: target.effort,
          workspace,
          customRole: opts.customRole || null,
        })
      : undefined);

  const runId = opts.runId || crypto.randomUUID();
  const liveLogPath = getLiveLogPath(workspace, runId);
  const tool = opts.toolName || "worker_task";
  const connected = engine && !engine.closed ? engine : null;
  let unroute = () => {};
  if (connected) {
    // The session matches this run to the orchestrator's call by tool and
    // task, and its output streams there instead of into a file.
    connected.notify("run.started", { runId, tool, task: opts.prompt || "" });
    const decoder = new StringDecoder("utf8");
    unroute = routeLiveOutput(liveLogPath, (chunk) => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (text) connected.notify("run.output", { runId, text });
    });
  } else {
    setActiveLiveRun(workspace, { runId, tool, timestamp: Date.now() });
  }

  let ok = false;
  try {
    const result = await worker.executeTask({
      ...opts,
      workspace,
      provider: target.provider,
      model: target.model,
      effort: target.effort,
      mode: permission === "write" ? "workspace-write" : "read-only",
      permission,
      fileContents,
      systemPrompt,
      config,
      runId,
      liveLogPath,
    });
    ok = Boolean(result?.ok);
    return result;
  } finally {
    unroute();
    if (connected) connected.notify("run.finished", { runId, ok });
    else clearActiveLiveRun(workspace, runId);
  }
}

/**
 * Pull the unified diff out of a worker's preview text. Workers wrap it in
 * prose and often in a ```diff fence; fenced blocks are preferred, otherwise
 * everything from the first diff header on is taken.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function extractUnifiedDiff(text) {
  if (!text) return null;
  const isDiff = (s) => diffHeaderPaths(s).length > 0;
  const fenced = [];
  // Fences must sit on their own lines. Unanchored, a lazy match ended at the
  // first ``` anywhere — such as an added Markdown line "+```bash" — and
  // silently cut the diff short.
  const fence = /^```[ \t]*(?:diff|patch)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  let match;
  while ((match = fence.exec(text)) !== null) {
    if (isDiff(match[1])) fenced.push(match[1]);
  }
  let diff = fenced.length > 0 ? fenced.join("\n") : null;
  if (!diff) {
    const start = text.search(/^(diff --git |--- \S)/m);
    if (start === -1) return null;
    diff = text.slice(start);
    if (!isDiff(diff)) return null;
  }
  return diff.endsWith("\n") ? diff : `${diff}\n`;
}

/**
 * Directories that configure git or the agent tools around the workspace
 * (hooks, MCP servers, permission settings). A patch applied by the bridge,
 * outside any worker sandbox, must never write into them.
 */
const PROTECTED_PATCH_DIRS = new Set([".git", ".codex", ".claude", ".agents", ".gemini"]);

/** Escapes git uses inside a quoted path (`"a/\056git"`), besides `\ooo` octal bytes. */
const GIT_PATH_ESCAPES = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** Decode the C-style escapes of a quoted git path, so `\056codex` is seen as `.codex`. */
function decodeGitPath(p) {
  const bytes = Buffer.from(p, "utf-8")
    .toString("latin1")
    .replace(/\\([0-3][0-7]{2}|.)/g, (_, e) => (e.length === 3 ? String.fromCharCode(parseInt(e, 8)) : (GIT_PATH_ESCAPES[e] ?? e)));
  return Buffer.from(bytes, "latin1").toString("utf-8");
}

/**
 * The protected directory a path segment names, or null. Case-insensitive, and
 * NTFS-aware: it ignores trailing dots/spaces and `:stream` suffixes, and a
 * short name (`GIT~1`) names the same directory as `.git`.
 *
 * @param {string} segment
 * @returns {string|null}
 */
function protectedPatchDir(segment) {
  const name = segment.toLowerCase().replace(/:.*$/, "").replace(/[. ]+$/, "");
  if (PROTECTED_PATCH_DIRS.has(name)) return name;
  const short = /^([^~]+)~\d+$/.exec(name);
  return short && PROTECTED_PATCH_DIRS.has(`.${short[1]}`) ? `.${short[1]}` : null;
}

/** @param {string} p */
const outsideMessage = (p) => `the diff names a path outside the workspace (${p})`;
/** @param {string} dir @param {string} p */
const protectedMessage = (dir, p) => `the diff touches ${dir}/ (${p}), which is never patched through the bridge; make that change by hand`;
const SYMLINK_MESSAGE = "the diff creates or changes a symbolic link";

/**
 * Whether a mode, as git reads it (octal, up to the first non-digit, so
 * `0120000` and `120644` count), is a symbolic link.
 *
 * @param {string} mode
 * @returns {boolean}
 */
function isSymlinkMode(mode) {
  return (parseInt(mode, 8) & 0o170000) === 0o120000;
}

/**
 * Why a path a patch names must not be written, or null when it is fine.
 *
 * @param {string} p - as written in the patch, relative to the workspace
 * @returns {string|null}
 */
function patchPathProblem(p) {
  // Raw and decoded: backslashes are separators on Windows but escapes in a
  // quoted git path, and either reading must pass.
  for (const candidate of new Set([p, decodeGitPath(p)])) {
    const segments = candidate.split(/[\\/]/);
    if (path.isAbsolute(candidate) || /^([A-Za-z]:|[\\/])/.test(candidate) || segments.includes("..")) {
      return outsideMessage(p);
    }
    const dir = segments.map(protectedPatchDir).find(Boolean);
    if (dir) return protectedMessage(dir, p);
  }
  return null;
}

/**
 * Like {@link patchPathProblem} for text that holds paths git splits by rules
 * of its own (a `diff --git` line, where a name may contain spaces): every
 * fragment between separators, quotes, braces and whitespace is looked at, so
 * nothing depends on guessing where one path ends. It can only over-refuse.
 *
 * @param {string} text
 * @returns {string|null}
 */
function patchTextProblem(text) {
  for (const candidate of new Set([text, decodeGitPath(text)])) {
    for (const fragment of candidate.split(/["\s/\\{}]+/)) {
      if (fragment === "..") return outsideMessage(text);
      const dir = protectedPatchDir(fragment);
      if (dir) return protectedMessage(dir, text);
    }
  }
  return null;
}

/**
 * Why an approved diff must not be applied, according to its own text, or
 * null. This is the first of two layers; the second asks git what it reads
 * (see {@link gitPatchRefusal}), because git and this scan can disagree on a
 * crafted patch. Here every `---`/`+++` line counts by itself (git does not
 * need them in pairs), as do `rename`/`copy` lines in both spellings (`from`/
 * `to` and the legacy `old`/`new`) and each mode line. A header line with a
 * bare CR, VT or FF is refused: git ends a name there, so the name it reads is
 * not the one on the line.
 *
 * @param {string} diff
 * @returns {string|null}
 */
function patchRefusal(diff) {
  if (diff.includes("\0")) return "the diff contains a NUL byte";
  /** @type {string[]} */
  const named = [];
  const unquote = (/** @type {string} */ p) => p.replace(/^"(.*)"$/s, "$1");
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Hunk bodies start with a space, `+`, `-` or `\` and may hold any
    // character. `--- ` and `+++ ` lines are read as headers wherever they sit.
    if (/^[ +\\-]/.test(line) && !/^(?:---|\+\+\+) /.test(line)) continue;
    if (/[\r\v\f]/.test(line)) return "the diff has a control character in a header line";

    const mode = /^(?:new file mode|deleted file mode|new mode|old mode)\s*(\d+)/.exec(line) || /^index \S+ (\d+)/.exec(line);
    if (mode && isSymlinkMode(mode[1])) return SYMLINK_MESSAGE;

    const header = /^(?:---|\+\+\+) (.*)$/.exec(line);
    if (header) {
      const p = unquote(header[1].split("\t")[0].trim());
      // Also without its first component: that is what `-p1` leaves.
      if (p && p !== "/dev/null") named.push(p, p.replace(/^[^/\\]*[/\\]/, ""));
      continue;
    }
    const moved = /^(?:rename|copy) (?:from|to|old|new) (.+)$/.exec(line);
    if (moved) named.push(unquote(moved[1]));
    if (line.startsWith("diff --git ")) {
      const problem = patchTextProblem(line.slice("diff --git ".length));
      if (problem) return problem;
    }
  }
  for (const p of named) {
    const problem = patchPathProblem(p);
    if (problem) return problem;
  }
  return null;
}

/**
 * Every path a `rename`/`copy` line of `git apply --summary` may name. The
 * summary prints `old => new`, or `prefix{old => new}suffix` when the two share
 * a prefix and suffix, and a name can hold those characters too, so each
 * reading is returned.
 *
 * @param {string} body - the text between `rename`/`copy` and the `(NN%)`
 * @returns {string[]}
 */
function renameCandidates(body) {
  /** @type {string[]} */
  const out = [];
  for (let i = body.indexOf(" => "); i !== -1; i = body.indexOf(" => ", i + 1)) {
    const left = body.slice(0, i);
    const right = body.slice(i + 4);
    out.push(left, right);
    const open = left.lastIndexOf("{");
    const close = right.indexOf("}");
    if (open !== -1 && close !== -1) {
      const before = left.slice(0, open);
      const after = right.slice(close + 1);
      out.push(before + left.slice(open + 1) + after, before + right.slice(0, close) + after);
    }
  }
  return out;
}

/**
 * The second layer: ask git what it reads in the patch, with the very flags
 * the apply will use, and check every path and mode it reports.
 * `--numstat -z` lists the file each patch writes (the deleted one for a
 * delete); `--summary` adds creations and deletions with their modes, mode
 * changes, and the source of a rename or copy, which `--numstat` leaves out.
 * Whatever the patch's text suggests, git is the one that will write.
 *
 * @param {(extra: string[]) => import("node:child_process").SpawnSyncReturns<string>} run
 * @param {string} prefix - the `--directory` root git prepends to every name, "" for none
 * @returns {string|null} why to refuse, or null (also when git cannot read the patch: `--check` says why)
 */
export function gitPatchRefusal(run, prefix) {
  const numstat = run(["--numstat", "-z"]);
  const summary = run(["--summary"]);
  if (numstat.status !== 0 || summary.status !== 0) return null;

  /** @type {string[]} */
  const named = [];
  for (const record of numstat.stdout.split("\0")) {
    const entry = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]+)$/.exec(record);
    if (entry) named.push(entry[1]);
  }
  for (const line of summary.stdout.split("\n")) {
    const created = /^ (?:create|delete) mode (\d+) /.exec(line);
    if (created && isSymlinkMode(created[1])) return SYMLINK_MESSAGE;
    const changed = /^ mode change (\d+) => (\d+) /.exec(line);
    if (changed && (isSymlinkMode(changed[1]) || isSymlinkMode(changed[2]))) return SYMLINK_MESSAGE;
    const moved = /^ (?:rename|copy) (.*) \(\d+%\)$/.exec(line);
    if (moved) named.push(...renameCandidates(moved[1].replace(/"/g, "")));
  }
  for (const name of named) {
    // Judge the name inside the workspace, not the repository path above it.
    const problem = patchPathProblem(prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name);
    if (problem) return problem;
  }
  return null;
}

/** What git says when it refuses a path itself: not a patch that merely went stale. */
const GIT_POLICY_ERROR_RE = /invalid path|beyond a symbolic link|is outside (?:of )?the repository/i;

/**
 * A failed `git apply`, as `applyApprovedDiff` reports it. Git's own
 * refusals of a path (`invalid path '.git/…'`, `beyond a symbolic link`) are
 * marked `refused`, so the caller does not answer them by letting a worker
 * write the change.
 *
 * @param {import("node:child_process").SpawnSyncReturns<string>} result
 * @param {string} fallback
 * @returns {{ ok: false, reason: string, refused?: boolean }}
 */
function gitFailure(result, fallback) {
  const text = (result.stderr || result.error?.message || fallback).trim();
  const reason = text.split("\n")[0];
  return GIT_POLICY_ERROR_RE.test(text) ? { ok: false, reason, refused: true } : { ok: false, reason };
}

/**
 * Apply an approved preview exactly as it was shown, with `git apply`.
 *
 * Re-running the worker after approval — the only path before — applies
 * whatever the model writes the second time, which need not be what the
 * operator approved. `--check` runs first so a patch that no longer applies
 * leaves the tree untouched; git refuses paths outside the working tree.
 *
 * A patch that is refused on policy (paths outside the workspace, protected
 * directories such as `.git/` or `.claude/`, symbolic links) comes back with
 * `refused: true`: it is not a patch that merely failed to apply, so the
 * caller must not fall back to letting a worker write the change instead.
 * Two layers decide: a scan of the patch text, then git's own report of the
 * files and modes it reads in it. Nothing is written unless both pass.
 *
 * No `--recount`: it rewrites hunk line counts to fit whatever body is
 * present, which hides a truncated diff. A hunk whose counts are wrong is
 * rejected instead, and the caller falls back or asks for a new preview.
 *
 * @param {string} cwd
 * @param {string} previewText
 * @returns {{ ok: true } | { ok: false, reason: string, refused?: boolean }}
 */
export function applyApprovedDiff(cwd, previewText) {
  const diff = extractUnifiedDiff(previewText);
  if (!diff) return { ok: false, reason: "the preview contains no unified diff" };

  const level = diffStripLevel(diffHeaderPaths(diff));
  const refusal = patchRefusal(diff);
  if (refusal) return { ok: false, reason: refusal, refused: true };

  // The patch names workspace-relative paths. Run inside a subdirectory of the
  // repository, git reads a `diff --git` patch as root-relative and silently
  // skips what lies outside that subdirectory (exit 0, nothing written), while
  // a plain `---`/`+++` patch is read cwd-relative. Running from the repository
  // root with `--directory=<workspace>` makes both mean the workspace.
  const prefix = git(cwd, ["rev-parse", "--show-prefix"]).trim();
  const top = prefix ? git(cwd, ["rev-parse", "--show-toplevel"]).trim() : "";
  const fromRoot = Boolean(prefix && top);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-apply-"));
  const patchFile = path.join(dir, "approved.patch");
  try {
    fs.writeFileSync(patchFile, diff, "utf-8");
    const base = ["apply", `-p${level}`, "--whitespace=nowarn", ...(fromRoot ? [`--directory=${prefix}`] : [])];
    // C locale: git's refusals are matched by their English text below.
    const env = { ...process.env, LC_ALL: "C", LANGUAGE: "C" };
    const run = (/** @type {string[]} */ extra) =>
      spawnSync("git", [...base, ...extra, "--", patchFile], {
        cwd: fromRoot ? top : cwd,
        encoding: "utf-8",
        timeout: 60000,
        env,
      });

    const gitRefusal = gitPatchRefusal(run, fromRoot ? prefix : "");
    if (gitRefusal) return { ok: false, reason: gitRefusal, refused: true };

    const check = run(["--check"]);
    if (check.status !== 0) return gitFailure(check, "git apply --check failed");
    const applied = run([]);
    if (applied.status !== 0) return gitFailure(applied, "git apply failed");
    return { ok: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** How long the bridge waits for a human decision in `interactive` mode. */
export const APPROVAL_TIMEOUT_MS = 300000;
const APPROVAL_POLL_MS = 500;

/**
 * True when a Kumo REPL is listening for approval handshake files.
 *
 * The bridge is always a non-TTY child process, so it cannot ask the operator
 * anything itself. `startCommand` sets this variable in the orchestrator's
 * environment; without it, `interactive` degrades to `diff-review`.
 */
function interactiveApprovalAvailable() {
  if (engine && !engine.closed) return engine.hello?.interactive === true;
  return process.env.KUMO_INTERACTIVE_APPROVAL === "1";
}

/**
 * Ask the REPL for a human decision via a file handshake — the bridge and the
 * REPL are separate processes with no other IPC channel.
 *
 * @param {{previewId: string, taskHash: string|null, tool: string, previewText: string}} request
 * @returns {Promise<{approved: boolean, reason?: string}>}
 */
async function awaitHumanApproval(request) {
  if (engine && !engine.closed) {
    try {
      const decision = await engine.request(
        "approval.request",
        { previewId: request.previewId, tool: request.tool, previewText: request.previewText },
        { timeoutMs: APPROVAL_TIMEOUT_MS }
      );
      return decision?.approved === true
        ? { approved: true }
        : { approved: false, reason: decision?.reason || "the operator declined the change" };
    } catch (err) {
      return { approved: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const dir = getApprovalDir(workspaceDir);
  const requestFile = path.join(dir, `${request.previewId}.json`);
  const decisionFile = path.join(dir, `${request.previewId}.decision.json`);

  try {
    atomicWriteJson(requestFile, { ...request, createdAt: Date.now() });
  } catch (err) {
    return { approved: false, reason: `could not request approval: ${err.message}` };
  }

  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      if (fs.existsSync(decisionFile)) {
        try {
          const decision = JSON.parse(fs.readFileSync(decisionFile, "utf-8"));
          return decision?.approved === true
            ? { approved: true }
            : { approved: false, reason: "the operator declined the change" };
        } catch {
          return { approved: false, reason: "approval decision file was unreadable" };
        }
      }
      await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
    }
    return {
      approved: false,
      reason: `no operator response within ${Math.round(APPROVAL_TIMEOUT_MS / 1000)}s`,
    };
  } finally {
    for (const f of [requestFile, decisionFile]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}

function errorResult(text) {
  return { content: [{ type: "text", text: `[ERROR] ${text}` }], isError: true };
}

/**
 * Run one call of a role's tool.
 *
 * Every role goes through here. Read roles run the worker read-only. Write
 * roles — builder, tester, designer and custom write roles — differ only in
 * tool name, system prompt and confirmation wording; every safety rule below
 * must hold for all of them, so they share one code path instead of copies
 * that drift apart.
 *
 * @param {import("../config/roles.js").RoleInfo} registered - the role as its tool was registered
 * @param {Object} args
 * @param {{ onConfig?: (config: object) => void }} [hooks] - sees the effective settings of each call
 */
export async function handleRoleTool(registered, { task, files, confirm, previewId, model, effort, provider }, hooks = {}) {
  const toolName = registered.tool;
  const config = await effectiveConfig();
  hooks.onConfig?.(config);
  // The role as it is now — a custom role's prompt may have been edited since
  // the bridge started. Its access stays as registered: it fixed the schema.
  const current = findRole(config, registered.id);
  const role = current && current.access === registered.access ? current : registered;

  const dispatch = (extra) =>
    dispatchWorkerTask({
      toolName,
      prompt: task,
      config,
      files: files || [],
      workspace: workspaceDir,
      model,
      effort,
      provider,
      role: role.id,
      customRole: role.custom,
      ...extra,
    });

  if (role.access === "read") {
    return formatResult(await dispatch({ permission: "read" }), toolName);
  }

  const safetyMode = safetyModeOverride || config.safetyMode || "autonomous";
  const gated = safetyMode === "diff-review" || safetyMode === "interactive";

  // ── Phase 1: preview only ──
  if (gated && !confirm) {
    const result = await dispatch({ permission: "read", previewDiff: true, safetyMode });

    const formatted = formatResult(result, toolName);
    if (result.ok && result.stdout) {
      const generatedId = storePendingPreview(result.stdout, {
        taskHash: hashTask(task),
        safetyMode,
        workspaceDir,
      });
      if (formatted.content && formatted.content[0]) {
        const what = role.id === "tester" ? "a test proposal" : "a proposed change preview";
        const how =
          safetyMode === "interactive" && interactiveApprovalAvailable()
            ? `Safety mode is 'interactive'. Calling ${toolName} again with confirm: true and previewId: "${generatedId}" asks the operator to approve the change before anything is written.`
            : `Safety mode is '${safetyMode}'. To apply these changes, call ${toolName} again with confirm: true and previewId: "${generatedId}".`;
        formatted.content[0].text +=
          `\n\n---\n[STATUS: PENDING_CONFIRMATION]\n` +
          `The worker generated ${what} without modifying files on disk.\n` +
          `Preview ID: "${generatedId}"\n${how}`;
      }
    }
    return formatted;
  }

  // ── Phase 2: validate the confirmation, then apply ──
  let confirmedPreview = null;
  if (gated && confirm) {
    if (!previewId) {
      return errorResult(`${safetyMode} confirmation requires previewId.`);
    }
    // Peek, never consume: a failed apply must stay retryable with the same id.
    const cached = peekPendingPreview(previewId);
    if (!cached) {
      return errorResult("unknown or expired previewId.");
    }
    if (cached.taskHash && cached.taskHash !== hashTask(task)) {
      return errorResult("previewId does not match this task.");
    }
    if (cached.workspaceDir && cached.workspaceDir !== workspaceDir) {
      return errorResult("preview was generated for a different workspace.");
    }
    confirmedPreview = cached.previewText;

    if (safetyMode === "interactive" && interactiveApprovalAvailable()) {
      const decision = await awaitHumanApproval({
        previewId,
        taskHash: cached.taskHash,
        tool: toolName,
        previewText: cached.previewText,
      });
      if (!decision.approved) {
        // The preview stays cached so the call can be retried.
        return errorResult(`change not applied: ${decision.reason}.`);
      }
    }
  }

  const preState = captureWorkspaceState(workspaceDir);

  let result;
  let note = "";
  if (confirmedPreview) {
    // Apply what was approved, byte for byte. Only when that is impossible is
    // the worker asked to redo the task, and the output says so.
    const applied = applyApprovedDiff(workspaceDir, confirmedPreview);
    if (applied.ok) {
      result = {
        ok: true,
        code: 0,
        stdout: "Applied the approved preview exactly as shown (git apply).",
        stderr: "",
        timedOut: false,
      };
    } else if (applied.refused) {
      // A patch the bridge will not write is not a stale one: re-running the
      // worker would just hand it the same write.
      return errorResult(`the approved diff was refused (${applied.reason}); nothing was written.`);
    } else if (safetyMode === "interactive" && interactiveApprovalAvailable()) {
      // The operator approved this exact diff, not whatever a re-run writes;
      // writing anything else would bypass the human gate.
      return errorResult(
        `the approved diff could not be applied verbatim (${applied.reason}); nothing was written. ` +
          `Request a new preview so the operator can approve the actual change.`
      );
    } else {
      note =
        `\n\n[NOTE: the approved diff could not be applied verbatim (${applied.reason}); ` +
        `the worker re-ran the task, so the result may differ from the preview.]`;
      result = await dispatch({ permission: "write", safetyMode });
    }
  } else {
    result = await dispatch({ permission: "write", safetyMode });
  }

  if (result.ok && previewId) {
    consumePendingPreview(previewId);
  }

  const formatted = formatResult(result, toolName);
  const postState = captureWorkspaceState(workspaceDir);
  const delta = changedFilesBetween(preState, postState);
  const diffStat = getGitDiffStat(workspaceDir);

  if (formatted.content && formatted.content[0]) {
    formatted.content[0].text += note;
    // Also after an exact apply: it confirms git touched the files the
    // operator saw, under the paths the preview named.
    if (confirmedPreview) {
      const fidelityWarning = checkDiffFidelity(confirmedPreview, delta);
      if (fidelityWarning) {
        formatted.content[0].text += fidelityWarning;
      }
    }
    if (delta.length > 0 || diffStat) {
      formatted.content[0].text += `\n\n[Applied Files & Diff Summary]\nFiles: ${delta.join(", ") || "(none)"}\n${diffStat}`;
    }
  }

  return formatted;
}

const taskField = z.string().min(1).max(8000).refine((v) => !/^\s*$/.test(v), "task must be non-empty");
const filesField = z.array(z.string().min(1).max(500).refine((f) => !/[\r\n\0]/.test(f), "newline-free")).max(20).optional();
const modelField = z.string().max(120).refine((v) => !v.startsWith("-") && !v.includes("\0"), "invalid model").optional();
const effortField = z.enum(EFFORT_LEVELS).optional();
// Enumerated from the worker registry: an unknown id would become the name of
// the executable the generic worker spawns.
const providerField = z.enum(KNOWN_WORKERS).optional();

/** What `task` and `files` mean for each built-in role; custom roles get the generic wording. */
const FIELD_HINTS = {
  scout: ["What to explore or search for in the codebase", "Optional file paths to focus on"],
  builder: ["A bounded implementation task with clear acceptance criteria", "Optional context file paths"],
  tester: ["What to test or which test suite to run", "Optional file paths under test"],
  researcher: ["The technical research question or documentation lookup", "Optional context files"],
  reviewer: ["What changes or files to review", "Files to review"],
  designer: ["The design task: what to design or change, for whom, and how it should look and feel", "Optional files the design touches"],
};

/**
 * The input schema of a role's tool. Write roles also take the two-phase
 * confirmation fields of the gated safety modes.
 *
 * @param {import("../config/roles.js").RoleInfo} role
 */
function schemaFor(role) {
  // Own keys only: a custom role may be called "constructor" or "toString".
  const [taskHint, filesHint] = Object.hasOwn(FIELD_HINTS, role.id)
    ? FIELD_HINTS[role.id]
    : ["The task for this role, with clear acceptance criteria", "Optional context file paths"];
  const shape = {
    task: taskField.describe(taskHint),
    files: filesField.describe(filesHint),
  };
  if (role.access === "write") {
    shape.confirm = z.boolean().optional().describe("When safetyMode is diff-review or interactive, set to true to apply the approved changes to disk. When omitted or false, generates a proposed diff preview.");
    shape.previewId = z.string().optional().describe("Unique preview token returned by Phase 1 preview call for diff-fidelity verification upon confirmation.");
  }
  shape.model = modelField.describe("Run this call on another model than the role's assignment");
  shape.effort = effortField.describe("Run this call at another reasoning effort than the role's assignment");
  shape.provider = providerField.describe("Run this call on another worker provider than the role's assignment");
  return shape;
}

/**
 * A role tool's description: the role, the model it runs on and what it is
 * for — "Reviewer role, runs on GPT-6 Astra (Codex), high effort. …" — so
 * the lead routes by the actual assignment.
 *
 * @param {import("../config/roles.js").RoleInfo} role
 * @param {object} config - the effective settings
 * @returns {string}
 */
export function describeRoleTool(role, config) {
  const target = resolveWorkerTarget({ role: role.id }, config);
  const where = `runs on ${describeTarget(target)}${target.assigned ? "" : " (the shared worker)"}`;
  const kind = role.custom ? `${role.title} role (custom)` : `${role.title} role`;
  const summary = role.summary ? ` ${/[.!?]$/.test(role.summary) ? role.summary : `${role.summary}.`}` : "";
  const access = role.custom ? (role.access === "write" ? " Can modify workspace files." : " Read-only.") : "";
  return `${kind}, ${where}.${summary}${access}`;
}

/**
 * Build the MCP server with one tool per role in `config`: the built-in roles
 * and the custom ones. A description is refreshed on the next call when its
 * role's model changed meanwhile; adding or removing a custom role needs a
 * new bridge (the session restarts its orchestrator and resumes the thread).
 *
 * @param {object} config - the effective settings
 * @returns {McpServer}
 */
export function createBridgeServer(config) {
  const server = new McpServer({
    name: "kumo-worker-bridge",
    version: VERSION,
    description: "Bridges frontier orchestrators to execution workers across providers with dynamic workspace resolution and safety guardrails.",
  });

  /** @type {Map<string, { role: import("../config/roles.js").RoleInfo, tool: any, description: string }>} */
  const tools = new Map();
  const refreshDescriptions = (current) => {
    for (const role of listRoles(current)) {
      const entry = tools.get(role.tool);
      if (!entry || entry.role.access !== role.access) continue;
      const description = describeRoleTool(role, current);
      if (description === entry.description) continue;
      entry.description = description;
      entry.tool.update({ description });
    }
  };

  for (const role of listRoles(config)) {
    const description = describeRoleTool(role, config);
    const tool = server.registerTool(
      role.tool,
      { title: `${role.title} role`, description, inputSchema: schemaFor(role) },
      (args) => handleRoleTool(role, args, { onConfig: refreshDescriptions })
    );
    tools.set(role.tool, { role, tool, description });
  }
  return server;
}

export async function startServer() {
  // Set here, not at import: only a running bridge spawns workers, and a
  // module-level write would leak into any process that merely imports this.
  process.env[NESTED_ENV] = "1";
  // The desktop app starts the bridge as Electron run as node. Node has booted
  // by now, so drop the switch: worker CLIs and the Electron or Playwright
  // tools they run would otherwise inherit it and start as plain Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  // Connect before serving: the first tool call must already know its
  // session, and the tool list is built from that session's roles.
  engine = await connectEngine({ version: VERSION });
  const server = createBridgeServer(await effectiveConfig());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Start immediately if executed directly
if (process.argv[1]?.endsWith("server.js")) {
  startServer().catch((err) => {
    console.error("MCP server error:", err);
    process.exit(1);
  });
}
