/**
 * server.js — MCP stdio bridge server with dynamic workspace support.
 *
 * Exposes five role-based worker tools (explore, implement, test, research,
 * review) to any MCP-capable orchestrator and routes each call to one of the
 * 13 supported worker providers — subscription CLIs (Antigravity, Codex,
 * Claude Code, OpenCode, CommandCode, Copilot, Cursor, Gemini CLI, Ollama) or
 * direct HTTP APIs (openai/anthropic/gemini/compat).
 *
 * The target workspace comes from `--workspace <path>`, else `KUMO_WORKSPACE`,
 * else the legacy `ORCHESTRATOR_WORKSPACE`, else the process working directory.
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
import {
  getLiveLogPath,
  setActiveLiveRun,
  clearActiveLiveRun,
  getApprovalDir,
} from "../data/sessions.js";
import { atomicWriteJson } from "../config/paths.js";
import { VERSION } from "../version.js";

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
 * A per-call provider override wins, then KUMO_WORKER_PROVIDER, then config.
 * The model and effort are read from config on every call so a `/model worker`
 * switch applies to the next call; they are only used when the call runs on
 * the configured provider — handing a Gemini model id to a per-call `claude`
 * override would just make that CLI fail.
 *
 * @param {{ provider?: string, model?: string, effort?: string }} opts
 * @param {object} config
 */
export function resolveWorkerTarget(opts, config) {
  const requested = opts.provider || null;
  const configured = canonicalizeProvider(
    process.env.KUMO_WORKER_PROVIDER ||
      config.workerProvider ||
      detectProviderForModel(opts.model || modelOverride || config.workerModel)
  );
  const provider = requested || configured;
  const onConfigured = !requested || canonicalizeProvider(requested) === configured;
  return {
    provider,
    requested,
    // --model / GEMINI_MODEL are overrides of the configured worker, so they
    // follow the same rule as the config values.
    model: opts.model || (onConfigured ? modelOverride || config.workerModel : undefined) || undefined,
    effort: opts.effort || (onConfigured ? effortOverride || config.workerEffort : undefined) || undefined,
  };
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
  const config = loadConfig();
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
      ? getSystemPrompt(opts.role, { workerModel: target.model, workerEffort: target.effort, workspace })
      : undefined);

  const runId = opts.runId || crypto.randomUUID();
  const liveLogPath = getLiveLogPath(workspace, runId);
  setActiveLiveRun(workspace, {
    runId,
    tool: opts.toolName || "worker_task",
    timestamp: Date.now(),
  });

  try {
    return await worker.executeTask({
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
  } finally {
    clearActiveLiveRun(workspace, runId);
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
 * Apply an approved preview exactly as it was shown, with `git apply`.
 *
 * Re-running the worker after approval — the only path before — applies
 * whatever the model writes the second time, which need not be what the
 * operator approved. `--check` runs first so a patch that no longer applies
 * leaves the tree untouched; git refuses paths outside the working tree.
 *
 * No `--recount`: it rewrites hunk line counts to fit whatever body is
 * present, which hides a truncated diff. A hunk whose counts are wrong is
 * rejected instead, and the caller falls back or asks for a new preview.
 *
 * @param {string} cwd
 * @param {string} previewText
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function applyApprovedDiff(cwd, previewText) {
  const diff = extractUnifiedDiff(previewText);
  if (!diff) return { ok: false, reason: "the preview contains no unified diff" };

  const headers = diffHeaderPaths(diff);
  const level = diffStripLevel(headers);
  const targets = headers.map((p) => (level === 1 ? p.slice(2) : p));
  const unsafe = targets.find((p) => path.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes(".."));
  if (unsafe) return { ok: false, reason: `the diff names a path outside the workspace (${unsafe})` };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-apply-"));
  const patchFile = path.join(dir, "approved.patch");
  try {
    fs.writeFileSync(patchFile, diff, "utf-8");
    const base = ["apply", `-p${level}`, "--whitespace=nowarn"];
    const run = (extra) =>
      spawnSync("git", [...base, ...extra, patchFile], { cwd, encoding: "utf-8", timeout: 60000 });
    const check = run(["--check"]);
    if (check.status !== 0) {
      const why = (check.stderr || check.error?.message || "git apply --check failed").trim().split("\n")[0];
      return { ok: false, reason: why };
    }
    const applied = run([]);
    if (applied.status !== 0) {
      return { ok: false, reason: (applied.stderr || "git apply failed").trim().split("\n")[0] };
    }
    return { ok: true };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Handler implementations
async function handleReadTool(kind, { task, files, model, effort, provider }) {
  const toolName = `worker_${kind}`;
  const result = await dispatchWorkerTask({
    toolName,
    prompt: task,
    permission: "read",
    files: files || [],
    workspace: workspaceDir,
    model,
    effort,
    provider,
    role: kind,
  });
  return formatResult(result, toolName);
}

async function handleExplore(args) {
  return handleReadTool("explore", args);
}

const server = new McpServer({
  name: "kumo-worker-bridge",
  version: VERSION,
  description: "Bridges frontier orchestrators to execution workers across providers with dynamic workspace resolution and safety guardrails.",
});

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
 * Shared implementation for the two write tools.
 *
 * `worker_implement` and `worker_test` differ only in tool name, system-prompt
 * key and confirmation wording; every safety rule below must hold for both, so
 * they share one code path instead of two copies that drift apart.
 *
 * @param {"implement"|"test"} kind
 * @param {Object} args
 */
async function handleWriteTool(kind, { task, files, confirm, previewId, model, effort, provider }) {
  const toolName = kind === "implement" ? "worker_implement" : "worker_test";
  const config = loadConfig();
  const safetyMode = safetyModeOverride || config.safetyMode || "autonomous";
  const gated = safetyMode === "diff-review" || safetyMode === "interactive";

  const dispatch = (extra) =>
    dispatchWorkerTask({
      toolName,
      prompt: task,
      safetyMode,
      files: files || [],
      workspace: workspaceDir,
      model,
      effort,
      provider,
      role: kind,
      ...extra,
    });

  // ── Phase 1: preview only ──
  if (gated && !confirm) {
    const result = await dispatch({ permission: "read", previewDiff: true });

    const formatted = formatResult(result, toolName);
    if (result.ok && result.stdout) {
      const generatedId = storePendingPreview(result.stdout, {
        taskHash: hashTask(task),
        safetyMode,
        workspaceDir,
      });
      if (formatted.content && formatted.content[0]) {
        const what = kind === "implement" ? "a proposed change preview" : "a test proposal";
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
      result = await dispatch({ permission: "write" });
    }
  } else {
    result = await dispatch({ permission: "write" });
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

async function handleImplement(args) {
  return handleWriteTool("implement", args);
}

async function handleTest(args) {
  return handleWriteTool("test", args);
}

async function handleResearch(args) {
  return handleReadTool("research", args);
}

async function handleReview(args) {
  return handleReadTool("review", args);
}

const taskField = z.string().min(1).max(8000).refine((v) => !/^\s*$/.test(v), "task must be non-empty");
const filesField = z.array(z.string().min(1).max(500).refine((f) => !/[\r\n\0]/.test(f), "newline-free")).max(20).optional();
const modelField = z.string().max(120).refine((v) => !v.startsWith("-") && !v.includes("\0"), "invalid model").optional();
const effortField = z.enum(["low", "medium", "high", "max"]).optional();
// Enumerated from the worker registry: an unknown id would become the name of
// the executable the generic worker spawns.
const providerField = z.enum(KNOWN_WORKERS).optional();

const schemas = {
  explore: {
    task: taskField.describe("What to explore or search for in the codebase"),
    files: filesField.describe("Optional file paths to focus on"),
    model: modelField.describe("Execution worker model"),
    effort: effortField.describe("Execution worker reasoning effort"),
    provider: providerField.describe("Execution worker provider override"),
  },
  implement: {
    task: taskField.describe("A bounded implementation task with clear acceptance criteria"),
    files: filesField.describe("Optional context file paths"),
    confirm: z.boolean().optional().describe("When safetyMode is diff-review, set to true to apply approved changes to disk. When omitted or false, generates a proposed diff preview."),
    previewId: z.string().optional().describe("Unique preview token returned by Phase 1 preview call for diff-fidelity verification upon confirmation."),
    model: modelField.describe("Execution worker model"),
    effort: effortField.describe("Execution worker reasoning effort"),
    provider: providerField.describe("Execution worker provider override"),
  },
  test: {
    task: taskField.describe("What to test or which test suite to run"),
    files: filesField.describe("Optional file paths under test"),
    confirm: z.boolean().optional().describe("When safetyMode is diff-review, set to true to apply changes on disk."),
    previewId: z.string().optional().describe("Unique preview token returned by Phase 1 preview call for diff-fidelity verification upon confirmation."),
    model: modelField.describe("Execution worker model"),
    effort: effortField.describe("Execution worker reasoning effort"),
    provider: providerField.describe("Execution worker provider override"),
  },
  research: {
    task: taskField.describe("The technical research question or documentation lookup"),
    files: filesField.describe("Optional context files"),
    model: modelField.describe("Execution worker model"),
    effort: effortField.describe("Execution worker reasoning effort"),
    provider: providerField.describe("Execution worker provider override"),
  },
  review: {
    task: taskField.describe("What changes or files to review"),
    files: filesField.describe("Files to review"),
    model: modelField.describe("Execution worker model"),
    effort: effortField.describe("Execution worker reasoning effort"),
    provider: providerField.describe("Execution worker provider override"),
  },
};

// Primary role-based worker tools
server.tool(
  "worker_explore",
  "Read-only codebase exploration via execution worker. Locates files, symbols, execution paths, dependencies, and tests.",
  schemas.explore,
  handleExplore
);

server.tool(
  "worker_implement",
  "Execute a bounded coding task via execution worker. Modifies/creates workspace files.",
  schemas.implement,
  handleImplement
);

server.tool(
  "worker_test",
  "Write and/or run tests via execution worker. Generates tests and executes them using native project commands.",
  schemas.test,
  handleTest
);

server.tool(
  "worker_research",
  "Technical research via execution worker. Look up documentation, API specs, and technical patterns.",
  schemas.research,
  handleResearch
);

server.tool(
  "worker_review",
  "Independent code review via execution worker. Identifies correctness, security, and regression risks.",
  schemas.review,
  handleReview
);

export async function startServer() {
  // Set here, not at import: only a running bridge spawns workers, and a
  // module-level write would leak into any process that merely imports this.
  process.env[NESTED_ENV] = "1";
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
