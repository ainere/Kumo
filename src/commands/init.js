/**
 * init.js — CLI command to scaffold project instruction files into the current workspace.
 */

import fs from "node:fs";
import path from "node:path";

const AGENTS_TEMPLATE = `# Project Orchestration Rules (Codex × Gemini)

This project uses the **Codex × Gemini Cross-Provider Harness**.
- **Root Orchestrator**: ChatGPT 6 Astra (low reasoning, ChatGPT Plus)
- **Execution Worker**: Gemini 3.8 Flash (Google AI Pro via MCP bridge)

## Working Guidelines
- Break tasks into bounded chunks.
- Use \`gemini_explore\` to search and trace code paths.
- Use \`gemini_implement\` for code changes.
- Use \`gemini_test\` to write and run verification tests.
- Always review changes before completion.
`;

const GEMINI_TEMPLATE = `# Gemini Worker Rules

You are running as **Gemini 3.8 Flash** via the MCP bridge server.
- Stay inside the assigned scope.
- Prefer minimal, defensible changes.
- Return structured, concise findings.
`;

export function initCommand(opts = {}) {
  const targetDir = path.resolve(opts.dir || process.cwd());
  console.log(`\nInitializing cross-provider project rules in: ${targetDir}\n`);

  const agentsPath = path.join(targetDir, "AGENTS.md");
  const geminiPath = path.join(targetDir, "GEMINI.md");

  if (opts.dryRun) {
    console.log(`[Dry Run] Would create: ${agentsPath}`);
    console.log(`[Dry Run] Would create: ${geminiPath}`);
    return;
  }

  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, AGENTS_TEMPLATE, "utf-8");
    console.log(`  ✓ Created ${agentsPath}`);
  } else {
    console.log(`  ℹ ${agentsPath} already exists (skipping)`);
  }

  if (!fs.existsSync(geminiPath)) {
    fs.writeFileSync(geminiPath, GEMINI_TEMPLATE, "utf-8");
    console.log(`  ✓ Created ${geminiPath}`);
  } else {
    console.log(`  ℹ ${geminiPath} already exists (skipping)`);
  }

  console.log("\n✨ Initialization complete! Run 'orchestrator' to start an interactive session.\n");
}
