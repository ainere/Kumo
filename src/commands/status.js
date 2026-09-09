/**
 * status.js — Display live account usage limits, quotas, and provider health
 * for both the root orchestrator (Codex) and execution worker (Antigravity).
 */

import path from "node:path";
import { loadConfig } from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { checkAgyHealth, getAgyUsage } from "../../bridge/agy-runner.js";
import { getCachedQuotas, saveCachedQuotas } from "../utils/quota-cache.js";
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
  const g4 = c.skyBlue;

  const cached = getCachedQuotas();
  let codexLimits = cached.codex;

  const orchModelFull = config.reasoningEffort ? `${config.orchestratorModel}-${config.reasoningEffort}` : config.orchestratorModel;
  const workerModelFull = config.workerEffort ? `${config.workerModel}-${config.workerEffort}` : config.workerModel;
  const orchSub = codexLimits?.planType || (config.orchestratorProvider === "codex" ? "ChatGPT Plus" : "Codex");

  console.log(`  ${g1}${"Workspace:".padEnd(24)}${c.reset}${workspace}`);
  console.log(
    `  ${g1}${"Orchestrator:".padEnd(24)}${c.reset}${c.brightCyan}${orchModelFull}${c.reset}${c.gray} (${orchSub})${c.reset}`
  );
  console.log(
    `  ${g2}${"Worker:".padEnd(24)}${c.reset}${c.brightBlue}${workerModelFull}${c.reset}${c.gray} (Google AI Pro)${c.reset}`
  );
  console.log(separator(64));

  // 1. Query Codex live rate limits
  const client = new CodexAppClient();
  try {
    await client.start();
    codexLimits = await client.getRateLimits();
    await client.stop();
  } catch (err) {
    console.log(`  ${g2}${"Orchestrator Limits:".padEnd(24)}${c.reset}${badge.warn} (Could not query: ${err.message})`);
  }

  if (codexLimits) {
    const orchPeriod = codexLimits.windowMinutes
      ? codexLimits.windowMinutes <= 360 ? "5-Hour" : codexLimits.windowMinutes <= 11520 ? "Weekly" : "Monthly"
      : ((codexLimits.resetsAt - Date.now() / 1000) / 86400 > 8 ? "Monthly" : "Weekly");
    console.log(`  ${c.bold}Orchestrator (${orchSub}):${c.reset}`);
    console.log(`    ${`${orchPeriod} Remaining:`.padEnd(24)}${progressBar(codexLimits.remainingPercent, 14)}`);
    console.log(`    ${"Reset Time:".padEnd(24)}${c.brightYellow}${codexLimits.resetFormatted}${c.reset}`);

    if (codexLimits.creditsAvailable > 0) {
      console.log(`    ${"Reset Credits:".padEnd(24)}${c.brightGreen}${codexLimits.creditsAvailable} reset available${c.reset}`);
    } else {
      console.log(`    ${"Reset Credits:".padEnd(24)}${c.gray}0 resets available${c.reset}`);
    }
  }

  console.log(separator(64));

  // 2. Query Antigravity live usage & health
  const [workerHealth, agyUsage] = await Promise.all([
    checkAgyHealth().catch((e) => ({ authenticated: false, error: e.message })),
    getAgyUsage().catch(() => null),
  ]);

  saveCachedQuotas(codexLimits, agyUsage);

  const isClaudeOrGpt = /claude|gpt|anthropic/i.test(config.workerModel) || config.workerProvider === "claude";
  const workerTitle = isClaudeOrGpt ? `${config.workerModel} via Antigravity` : "Google AI Pro";
  console.log(`  ${c.bold}Worker Provider (${workerTitle}):${c.reset}`);
  if (workerHealth.authenticated) {
    console.log(`    ${"Health:".padEnd(24)}${badge.ok} Connected & Authenticated`);
    console.log(`    ${"Binary:".padEnd(24)}${c.gray}${workerHealth.binary}${c.reset}`);
  } else {
    console.log(`    ${"Health:".padEnd(24)}${badge.warn} CLI available, check login`);
    if (workerHealth.error) {
      console.log(`    ${"Detail:".padEnd(24)}${c.gray}${workerHealth.error.slice(0, 100)}${c.reset}`);
    }
  }

  if (agyUsage) {
    const weeklyPercent = isClaudeOrGpt
      ? agyUsage.claudeGptWeeklyPercent
      : agyUsage.geminiWeeklyPercent;
    const weeklyReset = isClaudeOrGpt
      ? (agyUsage.claudeGptWeeklyResetFormatted || "weekly")
      : (agyUsage.geminiWeeklyResetFormatted || "weekly");

    if (weeklyPercent !== null && weeklyPercent !== undefined) {
      console.log(
        `    ${"Weekly Remaining:".padEnd(24)}${progressBar(weeklyPercent, 14)} (${weeklyReset})`
      );
    }

    const fiveHourPercent = isClaudeOrGpt
      ? agyUsage.claudeGpt5HourPercent
      : agyUsage.gemini5HourPercent;
    const fiveHourReset = isClaudeOrGpt
      ? (agyUsage.claudeGpt5HourResetFormatted || "5-hour")
      : (agyUsage.gemini5HourResetFormatted || "5-hour");

    if (fiveHourPercent !== null && fiveHourPercent !== undefined) {
      console.log(
        `    ${"5-Hour Remaining:".padEnd(24)}${progressBar(fiveHourPercent, 14)} (${fiveHourReset})`
      );
    }
  }

  console.log(separator(64) + "\n");
}
