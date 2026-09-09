/**
 * status.js — Display live account usage limits, quotas, and provider health
 * for both the root orchestrator (Codex) and execution worker (Antigravity).
 */

import path from "node:path";
import { loadConfig } from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { checkAgyHealth, getAgyUsage } from "../../bridge/agy-runner.js";
import { saveCachedQuotas } from "../utils/quota-cache.js";
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

  const g1 = c.brightCyan;
  const g2 = c.cyan;
  const g3 = c.brightBlue;
  const g4 = c.blue;

  console.log(`  ${g1}${"Workspace:".padEnd(20)}${c.reset}${workspace}`);
  console.log(
    `  ${g1}${"Orchestrator:".padEnd(20)}${c.reset}${c.brightCyan}${config.orchestratorModel}${c.reset}${c.dim} (${config.orchestratorProvider || "codex"}, reasoning: ${config.reasoningEffort})${c.reset}`
  );
  console.log(
    `  ${g2}${"Worker:".padEnd(20)}${c.reset}${c.brightBlue}${config.workerModel}${c.reset}${c.dim} (${config.workerProvider || "gemini"} via MCP Bridge)${c.reset}`
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
    console.log(`  ${g2}${"Orchestrator Limits:".padEnd(20)}${c.reset}${badge.warn} (Could not query: ${err.message})`);
  }

  if (codexLimits) {
    console.log(`  ${c.bold}Orchestrator Quota (${codexLimits.planType}):${c.reset}`);
    console.log(`    ${"Monthly Remaining:".padEnd(20)}${progressBar(codexLimits.remainingPercent, 14)}`);
    console.log(`    ${"Reset Time:".padEnd(20)}${c.brightYellow}${codexLimits.resetFormatted}${c.reset}`);

    if (codexLimits.creditsAvailable > 0) {
      console.log(`    ${"Reset Credits:".padEnd(20)}${c.brightGreen}${codexLimits.creditsAvailable} reset available${c.reset}`);
    } else {
      console.log(`    ${"Reset Credits:".padEnd(20)}${c.dim}0 resets available${c.reset}`);
    }
  }

  console.log(separator(64));

  // 2. Query Antigravity live usage & health
  const [workerHealth, agyUsage] = await Promise.all([
    checkAgyHealth().catch((e) => ({ authenticated: false, error: e.message })),
    getAgyUsage().catch(() => null),
  ]);

  saveCachedQuotas(codexLimits, agyUsage);

  const isClaude = config.workerProvider === "claude";
  const workerTitle = isClaude ? "Claude" : "Antigravity / Google AI Pro";
  console.log(`  ${c.bold}Worker Provider (${workerTitle}):${c.reset}`);
  if (workerHealth.authenticated) {
    console.log(`    ${"Health:".padEnd(20)}${badge.ok} Connected & Authenticated`);
    console.log(`    ${"Binary:".padEnd(20)}${c.dim}${workerHealth.binary}${c.reset}`);
  } else {
    console.log(`    ${"Health:".padEnd(20)}${badge.warn} CLI available, check login`);
    if (workerHealth.error) {
      console.log(`    ${"Detail:".padEnd(20)}${c.dim}${workerHealth.error.slice(0, 100)}${c.reset}`);
    }
  }

  if (agyUsage) {
    const weeklyPercent = isClaude
      ? (agyUsage.claudeGptWeeklyPercent ?? agyUsage.geminiWeeklyPercent)
      : (agyUsage.geminiWeeklyPercent ?? agyUsage.claudeGptWeeklyPercent);
    const weeklyReset = isClaude
      ? (agyUsage.claudeGptWeeklyResetFormatted || "weekly")
      : (agyUsage.geminiWeeklyResetFormatted || "weekly");

    if (weeklyPercent !== null && weeklyPercent !== undefined) {
      console.log(
        `    ${"Weekly Remaining:".padEnd(20)}${progressBar(weeklyPercent, 14)} (${weeklyReset})`
      );
    }

    const fiveHourPercent = isClaude
      ? (agyUsage.claudeGpt5HourPercent ?? agyUsage.gemini5HourPercent)
      : (agyUsage.gemini5HourPercent ?? agyUsage.claudeGpt5HourPercent);
    const fiveHourReset = isClaude
      ? (agyUsage.claudeGpt5HourResetFormatted || "5-hour")
      : (agyUsage.gemini5HourResetFormatted || "5-hour");

    if (fiveHourPercent !== null && fiveHourPercent !== undefined) {
      console.log(
        `    ${"5-Hour Remaining:".padEnd(20)}${progressBar(fiveHourPercent, 14)} (${fiveHourReset})`
      );
    }

    if (!isClaude && agyUsage.claudeGptWeeklyPercent !== null) {
      const cReset = agyUsage.claudeGptWeeklyResetFormatted || "weekly";
      console.log(
        `    ${"Claude Pool:".padEnd(20)}${progressBar(agyUsage.claudeGptWeeklyPercent, 14)} (${cReset})`
      );
    }
  }

  console.log(separator(64) + "\n");
}
