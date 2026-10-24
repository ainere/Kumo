/**
 * run.js — CLI command for headless, one-shot task execution.
 */

import path from "node:path";
import { createOrchestratorClient, orchestratorDelegates } from "../providers/orchestrators/registry.js";
import { runTurn } from "../providers/orchestrators/turn-wait.js";
import { loadConfig } from "../config/settings.js";
import { c, badge, separator } from "../utils/ui.js";

/**
 * @param {string} taskPrompt
 * @param {{ dir?: string }} [opts]
 * @param {{ createClient?: typeof createOrchestratorClient, exit?: (code: number) => void }} [deps]
 *   test seams: a fake client factory, and a replacement for process.exit
 */
export async function runCommand(taskPrompt, opts = {}, deps = {}) {
  const createClient = deps.createClient || createOrchestratorClient;
  const exit = deps.exit || ((code) => process.exit(code));

  if (!taskPrompt || taskPrompt.trim() === "") {
    console.error(`${badge.fail} Please provide a task prompt. Example: kumo run "inspect the repo and write tests"`);
    exit(1);
    return;
  }

  const workspace = path.resolve(opts.dir || process.cwd());
  const config = loadConfig();
  const providerId = config.orchestratorProvider || "codex";

  console.log(`\n${c.bold}KUMO Task Execution${c.reset}`);
  console.log(separator(50));
  console.log(`  ${c.dim}Workspace:${c.reset} ${workspace}`);
  console.log(`  ${c.dim}Provider:${c.reset}  ${providerId}`);
  console.log(`  ${c.dim}Task:${c.reset}      ${taskPrompt}\n`);
  if (!orchestratorDelegates(providerId)) {
    console.log(
      `  ${badge.warn} ${providerId} cannot call Kumo's worker tools; it will answer the task on its own.\n`
    );
  }

  let client = null;
  let ok = false;
  let onSigint = null;

  try {
    client = createClient({
      workspace,
      model: config.orchestratorModel,
      provider: providerId,
      effort: config.reasoningEffort,
      config,
      env: { KUMO_WORKSPACE: workspace, ORCHESTRATOR_WORKSPACE: workspace },
    });

    client.on("delta", (chunk) => process.stdout.write(chunk));
    client.on("stderr", (chunk) => process.stderr.write(chunk));
    client.on("warning", (w) => console.error(`\n${badge.warn} ${w?.message || w}`));
    client.on("notice", (text) => console.error(`${badge.info} ${text}`));
    // Nobody is at the keyboard to approve anything; say what was refused
    // rather than letting the request stall the turn.
    client.on("server_request", (req) => {
      if (req.isApproval) {
        console.error(`\n${badge.warn} Declined (headless run): ${req.description.split("\n")[0]}`);
      }
      req.decline();
    });

    // start() spawns long-lived clients (Codex app-server); for the others it
    // is a no-op. Skipping it left every Codex request failing with "not running".
    await client.start();
    await client.startThread({ workspace, model: config.orchestratorModel, reasoningEffort: config.reasoningEffort });

    const turn = runTurn(
      client,
      () => client.startTurn(taskPrompt, { model: config.orchestratorModel, effort: config.reasoningEffort }),
      { timeoutMs: config.turnTimeoutMs }
    );
    onSigint = () => {
      console.error(`\n${badge.warn} Interrupting…`);
      turn.interrupt();
    };
    process.once("SIGINT", onSigint);

    const outcome = await turn.done;
    ok = outcome.ok;
    if (!ok) {
      console.error(`\n${badge.fail} Turn ended without completion: ${outcome.reason}`);
    }
  } catch (err) {
    console.error(`\n${badge.fail} Task execution failed: ${err.message}`);
    ok = false;
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
    if (client) {
      try {
        await client.stop();
      } catch {
        /* teardown failure must not mask the task outcome */
      }
    }
  }

  exit(ok ? 0 : 1);
}
