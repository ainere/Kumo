/**
 * server.js — MCP stdio bridge server with dynamic workspace support.
 *
 * Exposes five role-based worker tools (explore, implement, test, research,
 * review) to any MCP-capable orchestrator and routes each call to one of the
 * fifteen supported worker providers — subscription CLIs (Antigravity/Gemini,
 * Codex, Claude Code, OpenCode, CommandCode, Copilot, Cursor, Gemini CLI,
 * Ollama) or direct HTTP APIs (openai/anthropic/gemini/compat).
 *
 * The target workspace comes from `--workspace <path>`, else `KUMO_WORKSPACE`,
 * else the legacy `ORCHESTRATOR_WORKSPACE`, else the process working directory.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgy } from "./agy-runner.js";
import { getWorker, KNOWN_WORKERS } from "../providers/workers/registry.js";
import { getSystemPrompt } from "./prompts.js";
import { loadConfig, detectProviderForModel } from "../config/settings.js";
import {
  getLiveLogPath,
  setActiveLiveRun,
  clearActiveLiveRun,
  getApprovalDir,
} from "../data/sessions.js";
import { atomicWriteJson } from "../config/paths.js";
import { VERSION } from "../cli.js";

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
 * Capture current git porcelain status (modified and untracked files).
 */
export function getGitStatus(cwd) {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((l) => {
        const status = l.slice(0, 2);
        let p = l.slice(3).trim();
        if (status.includes("R")) {
          const arrow = p.indexOf("->");
          if (arrow !== -1) p = p.slice(arrow + 2).trim();
        }
        if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
          p = p.slice(1, -1);
        }
        return p;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Capture git diff stat summary.
 */
export function getGitDiffStat(cwd) {
  try {
    const out = execSync("git diff HEAD --stat", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    return out || "";
  } catch {
    return "";
  }
}

/**
 * Capture the names of tracked files with uncommitted modifications.
 */
export function getGitDiffNames(cwd) {
  try {
    const out = execSync("git diff HEAD --name-only", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    return out ? out.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
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
  for (const f of files) {
    hashes.set(f, hashFileContent(path.join(cwd, f)));
  }
  return { files, hashes };
}

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
  const changed = [];
  for (const f of post.files) {
    if (!pre.hashes.has(f) || pre.hashes.get(f) !== post.hashes.get(f)) {
      changed.push(f);
    }
  }
  return changed;
}

/**
 * Extract target file paths mentioned in a unified diff or file header preview.
 */
export function extractPreviewFiles(previewText) {
  if (!previewText) return [];
  const files = new Set();
  const diffRegex = /(?:---|\+\+\+)\s+[ab]\/([^\s]+)/g;
  let match;
  while ((match = diffRegex.exec(previewText)) !== null) {
    if (match[1] && match[1] !== "dev/null") {
      files.add(match[1]);
    }
  }
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

  return {
    content: [
      {
        type: "text",
        text: result.stdout || "(no output)",
      },
    ],
  };
}

const server = new McpServer({
  name: "kumo-worker-bridge",
  version: VERSION,
  description: "Bridges frontier orchestrators to execution workers across providers with dynamic workspace resolution and safety guardrails.",
});

/**
 * Dispatch task to the active worker provider (subscription CLI or direct API).
 * Per-call provider override wins, then KUMO_WORKER_PROVIDER, then config.
 */
export async function dispatchWorkerTask(opts) {
  const config = loadConfig();
  // opts.provider is model-authored, so it may only name a known worker: the id
  // becomes the executable the generic worker spawns. Operator-configured
  // fallbacks may opt into an arbitrary CLI.
  const requested = opts.provider;
  const configured =
    process.env.KUMO_WORKER_PROVIDER ||
    config.workerProvider ||
    detectProviderForModel(opts.model || modelOverride || config.workerModel);
  const workerProvider = requested || configured;
  const worker = getWorker(workerProvider, { allowGeneric: !requested });

  const runId = opts.runId || crypto.randomUUID();
  const liveLogPath = getLiveLogPath(workspaceDir, runId);
  setActiveLiveRun(workspaceDir, {
    runId,
    tool: opts.toolName || "worker_task",
    timestamp: Date.now(),
  });

  try {
    return await worker.executeTask({
      ...opts,
      config,
      runId,
      liveLogPath,
    });
  } finally {
    clearActiveLiveRun(workspaceDir, runId);
  }
}

// Handler implementations
async function handleExplore({ task, files, model, effort, provider }) {
  const activeModel = model || modelOverride || undefined;
  const activeEffort = effort || effortOverride || undefined;
  const result = await dispatchWorkerTask({
    toolName: "worker_explore",
    prompt: task,
    mode: "read-only",
    files: files || [],
    workspace: workspaceDir,
    model: activeModel,
    effort: activeEffort,
    provider,
    systemPrompt: getSystemPrompt("explore", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });
  return formatResult(result, "worker_explore");
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
  const activeModel = model || modelOverride || undefined;
  const activeEffort = effort || effortOverride || undefined;
  const gated = safetyMode === "diff-review" || safetyMode === "interactive";

  const systemPrompt = () =>
    getSystemPrompt(kind, {
      workerModel: activeModel,
      workerEffort: activeEffort,
      workspace: workspaceDir,
    });

  // ── Phase 1: preview only ──
  if (gated && !confirm) {
    const result = await dispatchWorkerTask({
      toolName,
      prompt: task,
      mode: "read-only",
      previewDiff: true,
      safetyMode,
      files: files || [],
      workspace: workspaceDir,
      model: activeModel,
      effort: activeEffort,
      provider,
      systemPrompt: systemPrompt(),
    });

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

  const result = await dispatchWorkerTask({
    toolName,
    prompt: task,
    mode: "workspace-write",
    // Never widen permissions on confirmation: applying an approved preview must
    // not run with fewer restrictions than the mode the operator selected.
    safetyMode,
    files: files || [],
    workspace: workspaceDir,
    model: activeModel,
    effort: activeEffort,
    provider,
    systemPrompt: systemPrompt(),
  });

  if (result.ok && previewId) {
    consumePendingPreview(previewId);
  }

  const formatted = formatResult(result, toolName);
  const postState = captureWorkspaceState(workspaceDir);
  const delta = changedFilesBetween(preState, postState);
  const diffStat = getGitDiffStat(workspaceDir);

  if (formatted.content && formatted.content[0]) {
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

async function handleResearch({ task, files, model, effort, provider }) {
  const activeModel = model || modelOverride || undefined;
  const activeEffort = effort || effortOverride || undefined;
  const result = await dispatchWorkerTask({
    toolName: "worker_research",
    prompt: task,
    mode: "read-only",
    files: files || [],
    workspace: workspaceDir,
    model: activeModel,
    effort: activeEffort,
    provider,
    systemPrompt: getSystemPrompt("research", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });
  return formatResult(result, "worker_research");
}

async function handleReview({ task, files, model, effort, provider }) {
  const activeModel = model || modelOverride || undefined;
  const activeEffort = effort || effortOverride || undefined;
  const result = await dispatchWorkerTask({
    toolName: "worker_review",
    prompt: task,
    mode: "read-only",
    files: files || [],
    workspace: workspaceDir,
    model: activeModel,
    effort: activeEffort,
    provider,
    systemPrompt: getSystemPrompt("review", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });
  return formatResult(result, "worker_review");
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
