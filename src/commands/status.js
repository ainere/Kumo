/**
 * status.js — Display live account usage limits, quotas, and provider health
 * for both the root orchestrator (Codex) and execution worker (Antigravity).
 */

import path from "node:path";
import { loadConfig } from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { checkAgyHealth, getAgyUsage } from "../../bridge/agy-runner.js";
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
  console.log(`  ${c.bold}KUMO System & Live Account Quota Status${c.reset}`);
  console.log(separator(64));

  console.log(`  ${c.dim}Workspace:${c.reset}    ${workspace}`);
  console.log(
    `  ${c.dim}Orchestrator:${c.reset} ${c.brightCyan}${config.orchestratorModel}${c.reset} (${config.orchestratorProvider || "codex"}, reasoning: ${config.reasoningEffort})`
  );
  console.log(
    `  ${c.dim}Worker:${c.reset}       ${c.brightBlue}${config.workerModel}${c.reset} (${config.workerProvider || "gemini"} via MCP Bridge)`
  );
  console.log(separator(64));

  // 1. Query Codex live rate limits
  const client = new CodexAppClient();
  let codexLimits = null;
  try {
    await client.start();
    codexLimits = await client.getRateLimits();
    await client.stop();
  } catch (err) {
    console.log(`  ${c.dim}Orchestrator Limits:${c.reset} ${badge.warn} (Could not query: ${err.message})`);
  }

  if (codexLimits) {
    console.log(`  ${c.bold}Orchestrator Quota (${codexLimits.planType}):${c.reset}`);
    console.log(`    Monthly Remaining: ${progressBar(codexLimits.remainingPercent, 16)}`);
    console.log(`    Reset Time:        ${c.brightYellow}${codexLimits.resetFormatted}${c.reset}`);

    if (codexLimits.creditsAvailable > 0) {
      console.log(`    Reset Credits:     ${c.brightGreen}${codexLimits.creditsAvailable} reset available${c.reset}`);
    } else {
      console.log(`    Reset Credits:     ${c.dim}0 resets available${c.reset}`);
    }
  }

  console.log(separator(64));

  // 2. Query Antigravity live usage & health
  const [workerHealth, agyUsage] = await Promise.all([
    checkAgyHealth().catch((e) => ({ authenticated: false, error: e.message })),
    getAgyUsage().catch(() => null),
  ]);

  console.log(`  ${c.bold}Worker Provider (Antigravity / Google AI Pro):${c.reset}`);
  if (workerHealth.authenticated) {
    console.log(`    Health:            ${badge.ok} Connected & Authenticated`);
    console.log(`    Binary:            ${c.dim}${workerHealth.binary}${c.reset}`);
  } else {
    console.log(`    Health:            ${badge.warn} CLI available, check login`);
    if (workerHealth.error) {
      console.log(`    Detail:            ${c.dim}${workerHealth.error.slice(0, 100)}${c.reset}`);
    }
  }

  if (agyUsage) {
    if (agyUsage.geminiWeeklyPercent !== null) {
      console.log(
        `    Weekly Remaining:  ${progressBar(agyUsage.geminiWeeklyPercent, 16)} (${agyUsage.geminiWeeklyResetFormatted})`
      );
    }
    if (agyUsage.gemini5HourPercent !== null) {
      console.log(
        `    5-Hour Remaining:  ${progressBar(agyUsage.gemini5HourPercent, 16)} (${agyUsage.gemini5HourResetFormatted})`
      );
    }
    if (agyUsage.claudeGptWeeklyPercent !== null) {
      console.log(
        `    Claude & GPT Pool: ${c.dim}${agyUsage.claudeGptWeeklyPercent}% weekly • ${agyUsage.claudeGpt5HourPercent}% 5-hour${c.reset}`
      );
    }
  }

  console.log(separator(64) + "\n");
}
