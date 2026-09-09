/**
 * start.js — CLI command to launch the interactive cross-provider session.
 */

import path from "node:path";
import { getOrchestrator } from "../providers/orchestrators/registry.js";
import { loadConfig } from "../config/settings.js";

export async function startCommand(opts = {}) {
  const workspace = path.resolve(opts.dir || process.cwd());
  const config = loadConfig();

  const providerId = config.orchestratorProvider || "codex";
  const orchestrator = getOrchestrator(providerId);

  console.log("\n🕸️  Kumo (雲) — Cross-Provider Orchestration");
  console.log(`   📂 Workspace:    ${workspace}`);
  console.log(`   🧠 Orchestrator: ${config.orchestratorModel} (${providerId}, effort: ${config.reasoningEffort})`);
  console.log(`   ⚡ Worker:       ${config.workerModel} (${config.workerProvider || 'gemini'} via MCP Bridge)`);
  console.log("   🔑 Auth:         Subscriptions (Zero API keys)\n");

  try {
    const exitCode = await orchestrator.launch({
      workspace,
      nonInteractive: false,
      model: config.orchestratorModel,
      reasoningEffort: config.reasoningEffort,
    });
    process.exit(exitCode);
  } catch (err) {
    console.error(`\n❌ Failed to launch session: ${err.message}`);
    process.exit(1);
  }
}
