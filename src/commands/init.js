/**
 * init.js — CLI command to scaffold project instruction files into the current workspace.
 */

import fs from "node:fs";
import path from "node:path";
import { c, badge, separator } from "../utils/ui.js";
import { getObsidianVaultPath } from "../config/settings.js";

function getAgentsTemplate(vaultPath) {
  const vaultNote = vaultPath
    ? `- **Obsidian**: Consult and update the Obsidian knowledge vault (\`${vaultPath}\`) for durable project state.`
    : `- **Obsidian**: If configured via \`$KUMO_OBSIDIAN_VAULT\` or \`kumo config set obsidianVault <path>\`, consult and update the Obsidian knowledge vault for durable project state.`;

  return `# Project Orchestration Rules (Cross-Provider Harness)

This project coordinates a frontier reasoning model as the **Root Orchestrator** and a high-throughput execution model as the **Worker**.
- **Root Orchestrator**: Frontier reasoning model (default: ChatGPT 6 Astra via Codex CLI)
- **Execution Worker**: High-throughput worker (Gemini 3.8 Flash, Claude 3.7/Opus/Sonnet, or GPT-OSS via Antigravity / MCP bridge)
- **Reviewer**: Orchestrator subagent for deep cross-model review

## Delegation Gate
Classify tasks before substantive repository work:
- **Root-only**: For trivial 1-line typo fixes or simple questions only.
- **Delegated (Mandatory)**: Tasks MUST be delegated via worker MCP tools (\`worker_*\`) whenever:
  - The task spans multiple files, modules, or services.
  - Exploration or code search is required.
  - Implementation requires new logic or editing existing code.
  - Verification requires writing or running tests.
  - Debugging requires tracing across components.

> **Tool Invocation Rule**: The orchestrator must make actual MCP tool calls (\`worker_*\`). Do not describe, simulate, or silently perform delegated work directly in the root thread to conserve orchestrator message limits and reasoning quota.

## Concurrency & File Isolation
- Never run multiple \`worker_implement\` calls in parallel on overlapping files.
- Partition work into disjoint file sets or execute sequentially.

## Knowledge & Documentation Integrity
- **Graphify**: When exploring codebase structure, consult \`graphify-out/\` (\`GRAPH_REPORT.md\`, \`graph.json\`) when available for high-level cluster maps. Always verify active symbols against current source code; do not treat a stale graph as ground truth.
${vaultNote}
- **README Maintenance**: Whenever a major change is made (features, CLI commands, configs, architecture), update \`README.md\` immediately.
`;
}

const WORKER_TEMPLATE = `# Execution Worker Rules

You are running as the **Execution Worker** via the MCP bridge server dispatched by the root orchestrator.
- Stay strictly inside the assigned scope.
- Prefer the smallest defensible change.
- Never edit files when called as \`explore\`, \`research\`, or \`review\`.
- If a task becomes ambiguous, stop and report the blocker back to the orchestrator.
- Return structured reports matching the required format.
- When exploring codebase structure, use \`graphify-out/\` as a structural starting point if present, and verify active symbols against current source files.
`;

export function initCommand(opts = {}) {
  const targetDir = path.resolve(opts.dir || process.cwd());
  console.log(`\n${c.bold}Scaffolding Project Rules${c.reset}`);
  console.log(separator(50));
  console.log(`  ${c.dim}Target:${c.reset} ${targetDir}\n`);

  const agentsPath = path.join(targetDir, "AGENTS.md");
  const workerPath = path.join(targetDir, "GEMINI.md");

  if (opts.dryRun) {
    console.log(`  ${badge.info} [Dry Run] Would create: ${agentsPath}`);
    console.log(`  ${badge.info} [Dry Run] Would create: ${workerPath}`);
    return;
  }

  const vaultPath = getObsidianVaultPath();
  const agentsContent = getAgentsTemplate(vaultPath);

  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, agentsContent, "utf-8");
    console.log(`  ${badge.ok} Created ${agentsPath}`);
  } else {
    console.log(`  ${badge.info} ${agentsPath} already exists (skipping)`);
  }

  if (!fs.existsSync(workerPath)) {
    fs.writeFileSync(workerPath, WORKER_TEMPLATE, "utf-8");
    console.log(`  ${badge.ok} Created ${workerPath}`);
  } else {
    console.log(`  ${badge.info} ${workerPath} already exists (skipping)`);
  }

  console.log(`\n${badge.ok} Initialization complete. Run 'kumo' to start an interactive session.\n`);
}
