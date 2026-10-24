import path from "node:path";
import { VERSION } from "../version.js";
import { loadConfig, isCodexModel } from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { checkAgyHealth, getAgyUsage } from "../bridge/agy-runner.js";
import { getCachedQuotas, saveCachedQuotas } from "../utils/quota-cache.js";
import { getApiKey, getKeyEnvVarName, resolveBaseUrl } from "../providers/api/api-transport.js";
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

  console.log("\n" + getBanner(VERSION, style, DEFAULT_SUBTITLE));
  console.log(separator(64));
  console.log(`  ${c.bold}KUMO System & Live Account Quota Status${c.reset}`);
  console.log(separator(64));

  const g1 = c.brightCyan;
  const g2 = c.cyan;
  const g3 = c.brightBlue;

  const cached = getCachedQuotas();
  let codexLimits = cached.codex;
  const staleNote = cached.stale ? " (stale)" : "";

  const isOrchCodex = isCodexModel(config.orchestratorModel, config.orchestratorProvider);
  const isWorkerCodex = isCodexModel(config.workerModel, config.workerProvider);

  // Direct-API roles bypass subscription quota fetches (presence + base URL only, never secrets).
  const isApiProviderId = (p) => typeof p === "string" && p.toLowerCase().trim().endsWith("-api");
  const isOrchApi = isApiProviderId(config.orchestratorProvider);
  const isWorkerApi = isApiProviderId(config.workerProvider);
  const describeApiRole = (provider) => {
    const envVar = getKeyEnvVarName(provider);
    let keyState = "missing";
    try {
      keyState = getApiKey(provider) ? "set" : "missing";
    } catch {
      keyState = "missing";
    }
    let baseUrl = null;
    let baseUrlError = null;
    try {
      baseUrl = resolveBaseUrl(provider, config);
    } catch (err) {
      baseUrlError = err?.message || "base URL not configured";
    }
    return { envVar, keyState, baseUrl, baseUrlError };
  };

  const renderApiRole = (title, provider) => {
    const { envVar, keyState, baseUrl, baseUrlError } = describeApiRole(provider);
    const keyBadge = keyState === "set" ? badge.ok : badge.warn;
    const isCompat = String(provider).toLowerCase().trim() === "compat-api";
    const keyNote = isCompat && keyState !== "set" ? " (optional for compat-api)" : "";
    // Presence only — never print key material.
    console.log(`  ${c.bold}${title} (Direct API ${provider}):${c.reset}`);
    console.log(`    ${"API Key:".padEnd(24)}${keyBadge} env ${envVar}: ${keyState}${keyNote}`);
    if (baseUrl) {
      console.log(`    ${"Base URL:".padEnd(24)}${c.gray}${baseUrl}${c.reset}`);
    } else if (baseUrlError) {
      console.log(`    ${"Base URL:".padEnd(24)}${badge.warn} ${String(baseUrlError).slice(0, 120)}`);
    }
  };

  const orchModelFull = config.reasoningEffort ? `${config.orchestratorModel}-${config.reasoningEffort}` : config.orchestratorModel;
  const workerModelFull = config.workerEffort ? `${config.workerModel}-${config.workerEffort}` : config.workerModel;
  const orchSub = isOrchApi
    ? `Direct API (${config.orchestratorProvider})`
    : isOrchCodex
    ? (codexLimits?.planType || (config.orchestratorProvider === "codex" ? "ChatGPT Plus" : "Codex"))
    : (/claude|anthropic/i.test(config.orchestratorModel)
      ? "Anthropic via Antigravity"
      : /gpt|openai/i.test(config.orchestratorModel)
      ? "OpenAI via Antigravity"
      : "Google AI Pro");

  const workerSub = isWorkerApi
    ? `Direct API (${config.workerProvider})`
    : isWorkerCodex
    ? (codexLimits?.planType || (config.workerProvider === "codex" ? "ChatGPT Plus" : "Codex"))
    : (/claude|anthropic/i.test(config.workerModel)
      ? "Anthropic via Antigravity"
      : /gpt|openai/i.test(config.workerModel)
      ? "OpenAI via Antigravity"
      : "Google AI Pro");

  console.log(`  ${g1}${"Workspace:".padEnd(24)}${c.reset}${workspace}${staleNote}`);
  console.log(
    `  ${g1}${"Orchestrator:".padEnd(24)}${c.reset}${c.brightCyan}${orchModelFull}${c.reset}${c.gray} (${orchSub})${c.reset}`
  );
  console.log(
    `  ${g2}${"Worker:".padEnd(24)}${c.reset}${c.brightBlue}${workerModelFull}${c.reset}${c.gray} (${workerSub})${c.reset}`
  );
  console.log(separator(64));
  // Direct-API roles render presence + base URL only and skip subscription quota fetches.
  if (isOrchApi) {
    renderApiRole("Orchestrator", config.orchestratorProvider);
    console.log(separator(64));
  }
  if (isWorkerApi) {
    renderApiRole("Worker Provider", config.workerProvider);
    console.log(separator(64));
  }

  // 1. Query Codex live rate limits if either subscription role uses Codex (API roles skip).
  if ((isOrchCodex && !isOrchApi) || (isWorkerCodex && !isWorkerApi)) {
    const client = new CodexAppClient();
    try {
      await client.start();
      const freshCodex = await client.getRateLimits();
      if (freshCodex) codexLimits = freshCodex;
    } catch (err) {
      console.log(`  ${g2}${"Codex Limits:".padEnd(24)}${c.reset}${badge.warn} (Could not query: ${err.message})`);
    } finally {
      // A throw above used to skip stop() and orphan a codex app-server process.
      try {
        await client.stop();
      } catch {
        /* teardown failure must not mask the original error */
      }
    }
  }

  // Render Orchestrator Limits (subscription Codex only; API roles already rendered above).
  if (!isOrchApi && isOrchCodex && codexLimits) {
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
    console.log(separator(64));
  }

  // 2. Query Antigravity live usage & health when a non-API role needs it.
  let workerHealth = null;
  let agyUsage = null;
  if ((!isWorkerCodex && !isWorkerApi) || (!isOrchCodex && !isOrchApi)) {
    const [health, freshAgy] = await Promise.all([
      checkAgyHealth().catch((e) => ({ authenticated: false, error: e.message })),
      getAgyUsage().catch(() => null),
    ]);
    workerHealth = health;
    if (freshAgy) agyUsage = freshAgy;
  }

  saveCachedQuotas(codexLimits, agyUsage);

  // If Orchestrator is Antigravity, render its Antigravity limits
  if (!isOrchApi && !isOrchCodex && agyUsage) {
    const isClaude = /claude|anthropic/i.test(config.orchestratorModel);
    const weeklyPercent = isClaude ? agyUsage.claudeGptWeeklyPercent : agyUsage.geminiWeeklyPercent;
    const weeklyReset = isClaude ? (agyUsage.claudeGptWeeklyResetFormatted || "weekly") : (agyUsage.geminiWeeklyResetFormatted || "weekly");
    console.log(`  ${c.bold}Orchestrator (${orchSub}):${c.reset}`);
    if (weeklyPercent !== null && weeklyPercent !== undefined) {
      console.log(`    ${"Weekly Remaining:".padEnd(24)}${progressBar(weeklyPercent, 14)} (${weeklyReset})`);
    }
    console.log(separator(64));
  }

  // Render Worker Limits (API workers already rendered above; never fall through to subscription).
  if (isWorkerApi) {
    // Already rendered: presence + base URL. No subscription quota fetch for this role.
  } else if (isWorkerCodex) {
    console.log(`  ${c.bold}Worker Provider (${workerSub}):${c.reset}`);
    console.log(`    ${"Health:".padEnd(24)}${badge.ok} Connected & Authenticated (via Codex CLI)`);
    if (codexLimits) {
      const workerPeriod = codexLimits.windowMinutes
        ? codexLimits.windowMinutes <= 360 ? "5-Hour" : codexLimits.windowMinutes <= 11520 ? "Weekly" : "Monthly"
        : ((codexLimits.resetsAt - Date.now() / 1000) / 86400 > 8 ? "Monthly" : "Weekly");
      console.log(`    ${`${workerPeriod} Remaining:`.padEnd(24)}${progressBar(codexLimits.remainingPercent, 14)}`);
      console.log(`    ${"Reset Time:".padEnd(24)}${c.brightYellow}${codexLimits.resetFormatted}${c.reset}`);
      if (codexLimits.creditsAvailable > 0) {
        console.log(`    ${"Reset Credits:".padEnd(24)}${c.brightGreen}${codexLimits.creditsAvailable} reset available${c.reset}`);
      } else {
        console.log(`    ${"Reset Credits:".padEnd(24)}${c.gray}0 resets available${c.reset}`);
      }
    }
  } else {
    console.log(`  ${c.bold}Worker Provider (${workerSub}):${c.reset}`);
    if (workerHealth?.authenticated) {
      console.log(`    ${"Health:".padEnd(24)}${badge.ok} Connected & Authenticated`);
      console.log(`    ${"Binary:".padEnd(24)}${c.gray}${workerHealth.binary}${c.reset}`);
    } else {
      console.log(`    ${"Health:".padEnd(24)}${badge.warn} CLI available, check login`);
      if (workerHealth?.error) {
        console.log(`    ${"Detail:".padEnd(24)}${c.gray}${workerHealth.error.slice(0, 100)}${c.reset}`);
      }
    }

    if (agyUsage) {
      const isClaudeOrGpt = /claude|gpt|anthropic/i.test(config.workerModel) || config.workerProvider === "claude";
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
  }

  console.log(separator(64) + "\n");
}
