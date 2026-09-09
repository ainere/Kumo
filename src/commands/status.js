/**
 * status.js — Display live account usage limits, quotas, and provider health.
 */

import path from "node:path";
import { loadConfig } from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { checkAgyHealth } from "../../bridge/agy-runner.js";
import {
  getBanner,
  c,
  badge,
  separator,
  progressBar,
  DEFAULT_SUBTITLE,
} from "../utils/ui.js";

export async function statusCommand(opts = {}) {
  const config = loadConfig();
  const workspace = path.resolve(opts.dir || process.cwd());
  const style = config.bannerStyle || "cloud";

  console.log("\n" + getBanner("1.0.0", style, DEFAULT_SUBTITLE));
  console.log(separator(64));
  console.log(`  ${c.bold}KUMO System & Live Account Status${c.reset}`);
  console.log(separator(64));

  console.log(`  ${c.dim}Workspace:${c.reset}    ${workspace}`);
  console.log(
    `  ${c.dim}Orchestrator:${c.reset} ${c.brightCyan}${config.orchestratorModel}${c.reset} (${config.orchestratorProvider || "codex"}, reasoning: ${config.reasoningEffort})`
  );
  console.log(
    `  ${c.dim}Worker:${c.reset}       ${c.brightBlue}${config.workerModel}${c.reset} (${config.workerProvider || "gemini"} via MCP Bridge)`
  );
  console.log(separator(64));

  // Query Codex live rate limits
  const client = new CodexAppClient();
  let limits = null;
  try {
    await client.start();
    limits = await client.getRateLimits();
    await client.stop();
  } catch (err) {
    console.log(`  ${c.dim}Orchestrator Limits:${c.reset} ${badge.warn} (Could not query: ${err.message})`);
  }

  if (limits) {
    console.log(`  ${c.bold}Orchestrator Limits (${limits.planType}):${c.reset}`);
    console.log(`    Usage:       ${progressBar(limits.usedPercent, 16)}`);
    console.log(`    Reset Time:  ${c.brightYellow}${limits.resetFormatted}${c.reset}`);

    if (limits.creditsAvailable > 0) {
      console.log(`    Credits:     ${c.brightGreen}${limits.creditsAvailable} rate limit reset available${c.reset}`);
    } else {
      console.log(`    Credits:     ${c.dim}0 resets available${c.reset}`);
    }

    if (limits.secondary) {
      console.log(
        `    Secondary:   ${progressBar(limits.secondary.usedPercent, 16)} (${limits.secondary.resetFormatted})`
      );
    }
  }

  console.log(separator(64));

  // Check worker CLI health
  try {
    const workerHealth = await checkAgyHealth();
    if (workerHealth.authenticated) {
      console.log(`  ${c.bold}Worker Provider (Gemini / Antigravity):${c.reset}`);
      console.log(`    Status:      ${badge.ok} Authenticated & Connected`);
      console.log(`    Binary:      ${c.dim}${workerHealth.binary}${c.reset}`);
      console.log(`    Credentials: ${c.dim}Google AI Pro subscription active${c.reset}`);
    } else {
      console.log(`  ${c.bold}Worker Provider (Gemini / Antigravity):${c.reset}`);
      console.log(`    Status:      ${badge.warn} CLI available, not yet authenticated`);
      if (workerHealth.error) {
        console.log(`    Detail:      ${c.dim}${workerHealth.error.slice(0, 120)}${c.reset}`);
      }
    }
  } catch (err) {
    console.log(`  ${c.dim}Worker Status:${c.reset} ${badge.fail} ${err.message}`);
  }

  console.log(separator(64) + "\n");
}
