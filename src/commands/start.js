/**
 * start.js — CLI command to launch the interactive cross-provider session.
 */

import path from "node:path";
import { getOrchestrator } from "../providers/orchestrators/registry.js";
import { loadConfig } from "../config/settings.js";
import { getBanner, c, badge, separator } from "../utils/ui.js";

export async function startCommand(opts = {}) {
  const workspace = path.resolve(opts.dir || process.cwd());
  const config = loadConfig();

  const providerId = config.orchestratorProvider || "codex";
  const orchestrator = getOrchestrator(providerId);

  console.log("\n" + getBanner());
  console.log(separator(64));
  console.log(`  ${c.dim}Workspace:${c.reset}    ${workspace}`);
  console.log(`  ${c.dim}Orchestrator:${c.reset} ${c.brightCyan}${config.orchestratorModel}${c.reset} (${providerId}, reasoning: ${config.reasoningEffort})`);
  console.log(`  ${c.dim}Worker:${c.reset}       ${c.brightBlue}${config.workerModel}${c.reset} (${config.workerProvider || 'gemini'} via MCP Bridge)`);
  console.log(`  ${c.dim}Auth:${c.reset}         Subscription credentials (Zero API keys)`);
  console.log(separator(64) + "\n");

  try {
    const exitCode = await orchestrator.launch({
      workspace,
      nonInteractive: false,
      model: config.orchestratorModel,
      reasoningEffort: config.reasoningEffort,
    });
    process.exit(exitCode);
  } catch (err) {
    console.error(`\n${badge.fail} Failed to launch session: ${err.message}`);
    process.exit(1);
  }
}
