/**
 * run.js — CLI command for headless, one-shot task execution.
 */

import path from "node:path";
import { createOrchestratorClient } from "../providers/orchestrators/registry.js";
import { awaitTurnCompletion } from "../providers/orchestrators/turn-wait.js";
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

  console.log(`\n${c.bold}KUMO Task Execution${c.reset}`);
  console.log(separator(50));
  console.log(`  ${c.dim}Workspace:${c.reset} ${workspace}`);
  console.log(`  ${c.dim}Provider:${c.reset}  ${providerId}`);
  console.log(`  ${c.dim}Task:${c.reset}      ${taskPrompt}\n`);

  let client = null;
  let ok = false;

  try {
    client = createOrchestratorClient({
      workspace,
      model: config.orchestratorModel,
      provider: providerId,
      effort: config.reasoningEffort,
      config,
    });

    client.on("delta", (chunk) => process.stdout.write(chunk));
    client.on("stderr", (chunk) => process.stderr.write(chunk));

    await client.startThread({ workspace, model: config.orchestratorModel, reasoningEffort: config.reasoningEffort });

    const startTurnResult = await client.startTurn(taskPrompt, {
      model: config.orchestratorModel,
      effort: config.reasoningEffort,
    });

    const outcome = await awaitTurnCompletion(client, {
      timeoutMs: config.timeoutMs,
      startTurnResult,
    });

    ok = outcome.ok;
    if (!ok) {
      console.error(`\n${badge.fail} Turn ended without completion: ${outcome.reason}`);
    }
  } catch (err) {
    console.error(`\n${badge.fail} Task execution failed: ${err.message}`);
    ok = false;
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch {
        /* teardown failure must not mask the task outcome */
      }
    }
  }

  process.exit(ok ? 0 : 1);
}
