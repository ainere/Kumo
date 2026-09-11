/**
 * server.js — MCP stdio bridge server with dynamic workspace support.
 *
 * Exposes Gemini 3.8 Flash capabilities as MCP tools for Codex CLI.
 * Accepts `--workspace <path>` command line argument or reads
 * ORCHESTRATOR_WORKSPACE environment variable to target any project folder.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgy } from "./agy-runner.js";
import { getWorker } from "../providers/workers/registry.js";
import { SYSTEM_PROMPTS, getSystemPrompt } from "./prompts.js";
import { loadConfig, detectProviderForModel } from "../config/settings.js";
import { getLiveLogPath, setActiveLiveRun, clearActiveLiveRun } from "../data/sessions.js";
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

// In-memory cache for pending diff previews: Map<string, { previewText: string, createdAt: number }>
export const pendingPreviews = new Map();

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
export function storePendingPreview(previewText) {
  pruneExpiredPreviews();
  const previewId = `prev_${crypto.randomUUID().slice(0, 8)}`;
  pendingPreviews.set(previewId, {
    previewText,
    createdAt: Date.now(),
  });
  return previewId;
}

/**
 * Retrieve and consume a pending preview by previewId.
 * Falls back to latest unexpired preview if previewId is omitted.
 */
export function consumePendingPreview(previewId) {
  pruneExpiredPreviews();
  if (previewId && pendingPreviews.has(previewId)) {
    const entry = pendingPreviews.get(previewId);
    pendingPreviews.delete(previewId);
    return entry.previewText;
  }
  // Soft fallback: if previewId wasn't passed, take the most recent preview (if any exist)
  if (!previewId && pendingPreviews.size > 0) {
    let latestKey = null;
    let latestTime = 0;
    for (const [id, entry] of pendingPreviews.entries()) {
      if (entry.createdAt > latestTime) {
        latestTime = entry.createdAt;
        latestKey = id;
      }
    }
    if (latestKey) {
      const entry = pendingPreviews.get(latestKey);
      pendingPreviews.delete(latestKey);
      return entry.previewText;
    }
  }
  return null;
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
      .map((l) => l.trim().split(/\s+/)[1])
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
    const out = execSync("git diff --stat", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    return out || "(no unstaged git diff)";
  } catch {
    return "";
  }
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
  const fileHeaderRegex = /(?:\[FILE:\s*|File:\s*|modified:\s*)([^\s\],]+)/gi;
  while ((match = fileHeaderRegex.exec(previewText)) !== null) {
    if (match[1]) {
      files.add(match[1]);
    }
  }
  return Array.from(files);
}

/**
 * Sanity-check actual modified files against what was previewed in Phase 1.
 */
export function checkDiffFidelity(previewText, actualModifiedFiles) {
  if (!previewText || !actualModifiedFiles || actualModifiedFiles.length === 0) return null;
  const previewFiles = extractPreviewFiles(previewText);
  if (previewFiles.length === 0) return null;

  const unexpectedFiles = actualModifiedFiles.filter(
    (af) => !previewFiles.some((pf) => pf.endsWith(af) || af.endsWith(pf))
  );
  const missingFiles = previewFiles.filter(
    (pf) => !actualModifiedFiles.some((af) => pf.endsWith(af) || af.endsWith(pf))
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
 * Dispatch task to configured worker provider (Antigravity, Codex, Claude, etc.).
 */
export async function dispatchWorkerTask(opts) {
  const config = loadConfig();
  const workerProvider =
    process.env.KUMO_WORKER_PROVIDER ||
    config.workerProvider ||
    detectProviderForModel(opts.model || modelOverride || config.workerModel);
  const worker = getWorker(workerProvider);

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
      runId,
      liveLogPath,
    });
  } finally {
    clearActiveLiveRun(workspaceDir, runId);
  }
}

// Handler implementations
async function handleExplore({ task, files, model, effort }) {
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
    systemPrompt: getSystemPrompt("explore", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });
  return formatResult(result, "worker_explore");
}

async function handleImplement({ task, files, confirm, previewId, model, effort }) {
  const config = loadConfig();
  const safetyMode = safetyModeOverride || config.safetyMode || "autonomous";
  const activeModel = model || modelOverride || undefined;
  const activeEffort = effort || effortOverride || undefined;

  // If in diff-review mode and confirmation has not been provided
  if (safetyMode === "diff-review" && !confirm) {
    const result = await dispatchWorkerTask({
      toolName: "worker_implement",
      prompt: task,
      mode: "read-only",
      previewDiff: true,
      safetyMode: "diff-review",
      files: files || [],
      workspace: workspaceDir,
      model: activeModel,
      effort: activeEffort,
      systemPrompt: getSystemPrompt("implement", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
    });

    const formatted = formatResult(result, "worker_implement");
    if (result.ok && result.stdout) {
      const generatedId = storePendingPreview(result.stdout);
      if (formatted.content && formatted.content[0]) {
        formatted.content[0].text += `\n\n---\n[STATUS: PENDING_CONFIRMATION]\nSafety mode is 'diff-review'. The worker generated a proposed change preview without modifying files on disk.\nPreview ID: "${generatedId}"\nTo review and apply these changes, call worker_implement again with confirm: true and previewId: "${generatedId}".`;
      }
    }
    return formatted;
  }

  const preFiles = getGitStatus(workspaceDir);

  const result = await dispatchWorkerTask({
    toolName: "worker_implement",
    prompt: task,
    mode: "workspace-write",
    safetyMode: "autonomous",
    files: files || [],
    workspace: workspaceDir,
    model: activeModel,
    effort: activeEffort,
    systemPrompt: getSystemPrompt("implement", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });

  const formatted = formatResult(result, "worker_implement");
  const postFiles = getGitStatus(workspaceDir);
  const diffStat = getGitDiffStat(workspaceDir);

  if (formatted.content && formatted.content[0]) {
    const cachedPreview = consumePendingPreview(previewId);
    if (cachedPreview) {
      const fidelityWarning = checkDiffFidelity(cachedPreview, postFiles);
      if (fidelityWarning) {
        formatted.content[0].text += fidelityWarning;
      }
    }
    if (postFiles.length > 0 || diffStat) {
      formatted.content[0].text += `\n\n[Applied Files & Diff Summary]\nFiles: ${postFiles.join(", ") || "(none)"}\n${diffStat}`;
    }
  }

  return formatted;
}

async function handleTest({ task, files, confirm, previewId, model, effort }) {
  const config = loadConfig();
  const safetyMode = safetyModeOverride || config.safetyMode || "autonomous";
  const activeModel = model || modelOverride || undefined;
  const activeEffort = effort || effortOverride || undefined;

  if (safetyMode === "diff-review" && !confirm) {
    const result = await dispatchWorkerTask({
      toolName: "worker_test",
      prompt: task,
      mode: "read-only",
      previewDiff: true,
      safetyMode: "diff-review",
      files: files || [],
      workspace: workspaceDir,
      model: activeModel,
      effort: activeEffort,
      systemPrompt: getSystemPrompt("test", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
    });

    const formatted = formatResult(result, "worker_test");
    if (result.ok && result.stdout) {
      const generatedId = storePendingPreview(result.stdout);
      if (formatted.content && formatted.content[0]) {
        formatted.content[0].text += `\n\n---\n[STATUS: PENDING_CONFIRMATION]\nSafety mode is 'diff-review'. The worker generated a test proposal without modifying files on disk.\nPreview ID: "${generatedId}"\nTo execute and apply these tests, call worker_test again with confirm: true and previewId: "${generatedId}".`;
      }
    }
    return formatted;
  }

  const preFiles = getGitStatus(workspaceDir);

  const result = await dispatchWorkerTask({
    toolName: "worker_test",
    prompt: task,
    mode: "workspace-write",
    safetyMode: "autonomous",
    files: files || [],
    workspace: workspaceDir,
    model: activeModel,
    effort: activeEffort,
    systemPrompt: getSystemPrompt("test", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });

  const formatted = formatResult(result, "worker_test");
  const postFiles = getGitStatus(workspaceDir);
  const diffStat = getGitDiffStat(workspaceDir);

  if (formatted.content && formatted.content[0]) {
    const cachedPreview = consumePendingPreview(previewId);
    if (cachedPreview) {
      const fidelityWarning = checkDiffFidelity(cachedPreview, postFiles);
      if (fidelityWarning) {
        formatted.content[0].text += fidelityWarning;
      }
    }
    if (postFiles.length > 0 || diffStat) {
      formatted.content[0].text += `\n\n[Applied Files & Diff Summary]\nFiles: ${postFiles.join(", ") || "(none)"}\n${diffStat}`;
    }
  }

  return formatted;
}

async function handleResearch({ task, files, model, effort }) {
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
    systemPrompt: getSystemPrompt("research", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });
  return formatResult(result, "worker_research");
}

async function handleReview({ task, files, model, effort }) {
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
    systemPrompt: getSystemPrompt("review", { workerModel: activeModel, workerEffort: activeEffort, workspace: workspaceDir }),
  });
  return formatResult(result, "worker_review");
}

const schemas = {
  explore: {
    task: z.string().describe("What to explore or search for in the codebase"),
    files: z.array(z.string()).optional().describe("Optional file paths to focus on"),
    model: z.string().optional().describe("Execution worker model"),
    effort: z.string().optional().describe("Execution worker reasoning effort"),
  },
  implement: {
    task: z.string().describe("A bounded implementation task with clear acceptance criteria"),
    files: z.array(z.string()).optional().describe("Optional context file paths"),
    confirm: z.boolean().optional().describe("When safetyMode is diff-review, set to true to apply approved changes to disk. When omitted or false, generates a proposed diff preview."),
    previewId: z.string().optional().describe("Unique preview token returned by Phase 1 preview call for diff-fidelity verification upon confirmation."),
    model: z.string().optional().describe("Execution worker model"),
    effort: z.string().optional().describe("Execution worker reasoning effort"),
  },
  test: {
    task: z.string().describe("What to test or which test suite to run"),
    files: z.array(z.string()).optional().describe("Optional file paths under test"),
    confirm: z.boolean().optional().describe("When safetyMode is diff-review, set to true to apply changes on disk."),
    previewId: z.string().optional().describe("Unique preview token returned by Phase 1 preview call for diff-fidelity verification upon confirmation."),
    model: z.string().optional().describe("Execution worker model"),
    effort: z.string().optional().describe("Execution worker reasoning effort"),
  },
  research: {
    task: z.string().describe("The technical research question or documentation lookup"),
    files: z.array(z.string()).optional().describe("Optional context files"),
    model: z.string().optional().describe("Execution worker model"),
    effort: z.string().optional().describe("Execution worker reasoning effort"),
  },
  review: {
    task: z.string().describe("What changes or files to review"),
    files: z.array(z.string()).optional().describe("Files to review"),
    model: z.string().optional().describe("Execution worker model"),
    effort: z.string().optional().describe("Execution worker reasoning effort"),
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
