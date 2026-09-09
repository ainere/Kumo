/**
 * run.js — CLI command for headless, one-shot task execution.
 */

import path from "node:path";
import { getOrchestrator } from "../providers/orchestrators/registry.js";
import { loadConfig } from "../config/settings.js";
import { c, badge, separator } from "../utils/ui.js";

export async function runCommand(taskPrompt, opts = {}) {
  if (!taskPrompt || taskPrompt.trim() === "") {
    console.error(`${badge.fail} Please provide a task prompt. Example: kumo run "inspect the repo and write tests"`);
    process.exit(1);
  }

  const workspace = path.resolve(opts.dir || process.cwd());
  const config = loadConfig();

  const providerId = config.orchestratorProvider || "codex";
  const orchestrator = getOrchestrator(providerId);

  console.log(`\n${c.bold}KUMO Task Execution${c.reset}`);
  console.log(separator(50));
  console.log(`  ${c.dim}Workspace:${c.reset} ${workspace}`);
  console.log(`  ${c.dim}Task:${c.reset}      ${taskPrompt}\n`);

  try {
    const exitCode = await orchestrator.launch({
      workspace,
      nonInteractive: true,
      prompt: taskPrompt,
      model: config.orchestratorModel,
      reasoningEffort: config.reasoningEffort,
    });
    process.exit(exitCode);
  } catch (err) {
    console.error(`\n${badge.fail} Task execution failed: ${err.message}`);
    process.exit(1);
  }
}
