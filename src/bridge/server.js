/**
 * server.js — MCP stdio bridge server with dynamic workspace support.
 *
 * Exposes Gemini 3.8 Flash capabilities as MCP tools for Codex CLI.
 * Accepts `--workspace <path>` command line argument or reads
 * ORCHESTRATOR_WORKSPACE environment variable to target any project folder.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgy } from "./agy-runner.js";
import { SYSTEM_PROMPTS, getSystemPrompt } from "./prompts.js";

// Parse CLI flags
let workspaceDir = process.env.KUMO_WORKSPACE || process.env.ORCHESTRATOR_WORKSPACE || process.cwd();
let modelOverride = process.env.GEMINI_MODEL || null;
let effortOverride = null;
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
  }
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
  name: "codex-gemini-bridge",
  version: "1.0.0",
  description: "Bridges Codex CLI to execution worker with dynamic workspace resolution.",
});

// Handler implementations
async function handleExplore({ task, files }) {
  const result = await runAgy({
    prompt: task,
    mode: "read-only",
    files: files || [],
    workspace: workspaceDir,
    model: modelOverride || undefined,
    effort: effortOverride || undefined,
    systemPrompt: getSystemPrompt("explore", { workerModel: modelOverride, workerEffort: effortOverride }),
  });
  return formatResult(result, "worker_explore");
}

async function handleImplement({ task, files }) {
  const result = await runAgy({
    prompt: task,
    mode: "workspace-write",
    files: files || [],
    workspace: workspaceDir,
    model: modelOverride || undefined,
    effort: effortOverride || undefined,
    systemPrompt: getSystemPrompt("implement", { workerModel: modelOverride, workerEffort: effortOverride }),
  });
  return formatResult(result, "worker_implement");
}

async function handleTest({ task, files }) {
  const result = await runAgy({
    prompt: task,
    mode: "workspace-write",
    files: files || [],
    workspace: workspaceDir,
    model: modelOverride || undefined,
    effort: effortOverride || undefined,
    systemPrompt: getSystemPrompt("test", { workerModel: modelOverride, workerEffort: effortOverride }),
  });
  return formatResult(result, "worker_test");
}

async function handleResearch({ task, files }) {
  const result = await runAgy({
    prompt: task,
    mode: "read-only",
    files: files || [],
    workspace: workspaceDir,
    model: modelOverride || undefined,
    effort: effortOverride || undefined,
    systemPrompt: getSystemPrompt("research", { workerModel: modelOverride, workerEffort: effortOverride }),
  });
  return formatResult(result, "worker_research");
}

async function handleReview({ task, files }) {
  const result = await runAgy({
    prompt: task,
    mode: "read-only",
    files: files || [],
    workspace: workspaceDir,
    model: modelOverride || undefined,
    effort: effortOverride || undefined,
    systemPrompt: getSystemPrompt("review", { workerModel: modelOverride, workerEffort: effortOverride }),
  });
  return formatResult(result, "worker_review");
}

const schemas = {
  explore: {
    task: z.string().describe("What to explore or search for in the codebase"),
    files: z.array(z.string()).optional().describe("Optional file paths to focus on"),
  },
  implement: {
    task: z.string().describe("A bounded implementation task with clear acceptance criteria"),
    files: z.array(z.string()).optional().describe("Optional context file paths"),
  },
  test: {
    task: z.string().describe("What to test or which test suite to run"),
    files: z.array(z.string()).optional().describe("Optional file paths under test"),
  },
  research: {
    task: z.string().describe("The technical research question or documentation lookup"),
    files: z.array(z.string()).optional().describe("Optional context files"),
  },
  review: {
    task: z.string().describe("What changes or files to review"),
    files: z.array(z.string()).optional().describe("Files to review"),
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

// Backward-compatible gemini_* aliases
server.tool(
  "gemini_explore",
  "Alias for worker_explore. Read-only codebase exploration via execution worker.",
  schemas.explore,
  handleExplore
);

server.tool(
  "gemini_implement",
  "Alias for worker_implement. Execute a bounded coding task via execution worker.",
  schemas.implement,
  handleImplement
);

server.tool(
  "gemini_test",
  "Alias for worker_test. Write and/or run tests via execution worker.",
  schemas.test,
  handleTest
);

server.tool(
  "gemini_research",
  "Alias for worker_research. Technical research via execution worker.",
  schemas.research,
  handleResearch
);

server.tool(
  "gemini_review",
  "Alias for worker_review. Independent code review via execution worker.",
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
