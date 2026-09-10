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
import { SYSTEM_PROMPTS } from "./prompts.js";

// Parse --workspace flag from args if present
let workspaceDir = process.env.KUMO_WORKSPACE || process.env.ORCHESTRATOR_WORKSPACE || process.cwd();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace" && args[i + 1]) {
    workspaceDir = args[i + 1];
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
  description: "Bridges Codex CLI to Gemini 3.8 Flash with dynamic workspace resolution.",
});

// Tool: gemini_explore
server.tool(
  "gemini_explore",
  "Read-only codebase exploration via Gemini 3.8 Flash. Locates files, symbols, execution paths, dependencies, and tests.",
  {
    task: z.string().describe("What to explore or search for in the codebase"),
    files: z.array(z.string()).optional().describe("Optional file paths to focus on"),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      mode: "read-only",
      files: files || [],
      workspace: workspaceDir,
      systemPrompt: SYSTEM_PROMPTS.explore,
    });
    return formatResult(result, "gemini_explore");
  }
);

// Tool: gemini_implement
server.tool(
  "gemini_implement",
  "Execute a bounded coding task via Gemini 3.8 Flash. Modifies/creates workspace files.",
  {
    task: z.string().describe("A bounded implementation task with clear acceptance criteria"),
    files: z.array(z.string()).optional().describe("Optional context file paths"),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      mode: "workspace-write",
      files: files || [],
      workspace: workspaceDir,
      systemPrompt: SYSTEM_PROMPTS.implement,
    });
    return formatResult(result, "gemini_implement");
  }
);

// Tool: gemini_test
server.tool(
  "gemini_test",
  "Write and/or run tests via Gemini 3.8 Flash. Generates tests and executes them using native project commands.",
  {
    task: z.string().describe("What to test or which test suite to run"),
    files: z.array(z.string()).optional().describe("Optional file paths under test"),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      mode: "workspace-write",
      files: files || [],
      workspace: workspaceDir,
      systemPrompt: SYSTEM_PROMPTS.test,
    });
    return formatResult(result, "gemini_test");
  }
);

// Tool: gemini_research
server.tool(
  "gemini_research",
  "Technical research via Gemini 3.8 Flash. Look up documentation, API specs, and technical patterns.",
  {
    task: z.string().describe("The technical research question or documentation lookup"),
    files: z.array(z.string()).optional().describe("Optional context files"),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      mode: "read-only",
      files: files || [],
      workspace: workspaceDir,
      systemPrompt: SYSTEM_PROMPTS.research,
    });
    return formatResult(result, "gemini_research");
  }
);

// Tool: gemini_review
server.tool(
  "gemini_review",
  "Independent code review via Gemini 3.8 Flash. Identifies correctness, security, and regression risks.",
  {
    task: z.string().describe("What changes or files to review"),
    files: z.array(z.string()).optional().describe("Files to review"),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      mode: "read-only",
      files: files || [],
      workspace: workspaceDir,
      systemPrompt: SYSTEM_PROMPTS.review,
    });
    return formatResult(result, "gemini_review");
  }
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
