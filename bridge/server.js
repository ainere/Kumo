/**
 * server.js — MCP stdio bridge server.
 *
 * Exposes Antigravity (Gemini 3.8 Flash) capabilities as MCP tools
 * that the Codex CLI can discover and invoke. Communication happens
 * over stdin/stdout using the MCP JSON-RPC protocol.
 *
 * Tools exposed:
 *   gemini_explore   — Read-only codebase exploration
 *   gemini_implement — Bounded coding task execution
 *   gemini_test      — Test writing and execution
 *   gemini_research  — Technical research and documentation lookup
 *   gemini_review    — Independent code review
 *
 * All tools delegate to `agy` CLI subprocess calls. Authentication
 * uses the user's existing Google AI Pro subscription login — no API
 * keys are stored or transmitted.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAgy } from "./agy-runner.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "300000", 10);

// ---------------------------------------------------------------------------
// System prompts for each worker role
// ---------------------------------------------------------------------------

const SYSTEM_PROMPTS = {
  explore: `You are a repository exploration agent. Your job is to gather evidence, not to implement changes.

Do:
- Locate the smallest set of relevant files and symbols
- Trace the real call or data flow
- Identify the exact lines of code relevant to the question
- Report file paths, line numbers, and brief code snippets
- Note any related tests, configs, or dependencies

Do not:
- Modify any files
- Suggest implementation changes (the orchestrator handles that)
- Speculate about intent — report what the code actually does
- Include unnecessary context or boilerplate in your response

Be concise. Return structured findings.`,

  implement: `You are an implementation agent. Execute only the bounded task given to you.

Rules:
- Stay inside the assigned scope
- Prefer the smallest defensible change
- Follow existing repository patterns, naming, and formatting
- Avoid unrelated refactors
- Do not change architecture, public APIs, or unrelated behavior unless explicitly asked
- Write clear inline comments only where the code is non-obvious
- If the task cannot be completed as specified, report the blocker clearly

Return a summary of what you changed and why.`,

  test: `You are a testing agent. Write and/or run tests for the specified code.

Rules:
- Use the project's existing test framework and patterns
- Write focused tests that cover the specified behavior
- Include edge cases and error paths when appropriate
- Run the tests and report results
- If tests fail, report the failure clearly with relevant output
- Do not modify production code unless explicitly asked

Return: test file paths, pass/fail summary, and any failure details.`,

  research: `You are a technical research agent. Find accurate, specific information.

Rules:
- Search documentation, code, and available resources
- Cite sources (file paths, URLs, doc sections) for every claim
- Distinguish between verified facts and inferences
- If information is unavailable or uncertain, say so explicitly
- Be concise — the orchestrator needs actionable answers, not essays

Return structured findings with citations.`,

  review: `You are an independent code review agent. Review the actual change, not the intended story.

Prioritize:
- Correctness bugs
- Behavior regressions
- Security and permission issues
- Data loss or integrity risks
- Race conditions and concurrency bugs
- Missing or incorrect error handling
- Missing tests for changed behavior

For each issue found:
- State the file and line(s)
- Describe the actual problem (not just "looks wrong")
- Suggest a concrete fix

If the code is correct, say so. Do not invent issues.`,
};

// ---------------------------------------------------------------------------
// Helper: format the tool result
// ---------------------------------------------------------------------------

function formatResult(result, toolName) {
  if (result.timedOut) {
    return {
      content: [
        {
          type: "text",
          text: `[TIMEOUT] ${toolName} timed out after ${DEFAULT_TIMEOUT_MS / 1000}s.\n\nPartial output:\n${result.stdout || "(none)"}`,
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

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "codex-gemini-bridge",
  version: "1.0.0",
  description:
    "Bridges Codex CLI to Gemini 3.8 Flash via Antigravity CLI. " +
    "All authentication uses your existing Google AI Pro subscription.",
});

// ---------------------------------------------------------------------------
// Tool: gemini_explore
// ---------------------------------------------------------------------------

server.tool(
  "gemini_explore",
  "Read-only codebase exploration via Gemini 3.8 Flash. Use to locate files, " +
    "symbols, execution paths, dependencies, and tests before implementation.",
  {
    task: z.string().describe(
      "What to explore — e.g. 'Find all usages of the AuthService class' " +
        "or 'Trace the request flow from /api/users to the database'"
    ),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "Optional file paths to focus exploration on. " +
          "If omitted, the agent searches the full workspace."
      ),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      model: GEMINI_MODEL,
      mode: "read-only",
      files: files || [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      systemPrompt: SYSTEM_PROMPTS.explore,
    });
    return formatResult(result, "gemini_explore");
  }
);

// ---------------------------------------------------------------------------
// Tool: gemini_implement
// ---------------------------------------------------------------------------

server.tool(
  "gemini_implement",
  "Execute a bounded coding task via Gemini 3.8 Flash. The agent has " +
    "write access to the workspace. Use after exploration and when the " +
    "scope and acceptance criteria are clear.",
  {
    task: z.string().describe(
      "A bounded implementation task — e.g. 'Add input validation to " +
        "the createUser handler in src/handlers/users.ts' or 'Refactor " +
        "the retry logic in lib/http.js to use exponential backoff'"
    ),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "Optional file paths to provide as context. The agent can " +
          "read and write any workspace file regardless."
      ),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      model: GEMINI_MODEL,
      mode: "workspace-write",
      files: files || [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      systemPrompt: SYSTEM_PROMPTS.implement,
    });
    return formatResult(result, "gemini_implement");
  }
);

// ---------------------------------------------------------------------------
// Tool: gemini_test
// ---------------------------------------------------------------------------

server.tool(
  "gemini_test",
  "Write and/or run tests via Gemini 3.8 Flash. Use to create test " +
    "coverage for new or changed code, or to run existing tests and " +
    "report results.",
  {
    task: z.string().describe(
      "What to test — e.g. 'Write unit tests for the CartService.addItem " +
        "method' or 'Run the integration test suite and report failures'"
    ),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "Optional file paths of the code under test or existing test files."
      ),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      model: GEMINI_MODEL,
      mode: "workspace-write",
      files: files || [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      systemPrompt: SYSTEM_PROMPTS.test,
    });
    return formatResult(result, "gemini_test");
  }
);

// ---------------------------------------------------------------------------
// Tool: gemini_research
// ---------------------------------------------------------------------------

server.tool(
  "gemini_research",
  "Technical research via Gemini 3.8 Flash. Use to look up " +
    "documentation, verify version-specific behavior, find API " +
    "usage patterns, or answer technical questions.",
  {
    task: z.string().describe(
      "The research question — e.g. 'What is the correct way to " +
        "configure connection pooling in pg v9?' or 'What breaking " +
        "changes were introduced in React 19?'"
    ),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "Optional file paths for context (e.g. a package.json to check versions)."
      ),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      model: GEMINI_MODEL,
      mode: "read-only",
      files: files || [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      systemPrompt: SYSTEM_PROMPTS.research,
    });
    return formatResult(result, "gemini_research");
  }
);

// ---------------------------------------------------------------------------
// Tool: gemini_review
// ---------------------------------------------------------------------------

server.tool(
  "gemini_review",
  "Independent code review via Gemini 3.8 Flash. Use after " +
    "implementation to find correctness, security, regression, " +
    "concurrency, data-integrity, and missing-test risks.",
  {
    task: z.string().describe(
      "What to review — e.g. 'Review the changes in src/auth/ for " +
        "security issues' or 'Review the new caching layer for " +
        "correctness and race conditions'"
    ),
    files: z
      .array(z.string())
      .optional()
      .describe(
        "File paths of the changed files to review. If omitted, " +
          "the agent reviews recent workspace changes."
      ),
  },
  async ({ task, files }) => {
    const result = await runAgy({
      prompt: task,
      model: GEMINI_MODEL,
      mode: "read-only",
      files: files || [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      systemPrompt: SYSTEM_PROMPTS.review,
    });
    return formatResult(result, "gemini_review");
  }
);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running and listening on stdin/stdout.
  // Codex CLI will manage the lifecycle.
}

main().catch((err) => {
  console.error("Bridge server failed to start:", err);
  process.exit(1);
});
