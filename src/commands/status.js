/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import fs from "node:fs";
import path from "node:path";
import { VERSION } from "../version.js";
import { loadConfig, isCodexModel } from "../config/settings.js";
import { planLabel } from "../config/models.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { checkAgyHealth, getAgyUsage, isArgonModel } from "../bridge/agy-runner.js";
import { findClaudeBinary } from "../providers/workers/claude.js";
import { getCachedQuotas, saveCachedQuotas } from "../utils/quota-cache.js";
import { activeTargets } from "../config/roles.js";
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

  const cached = getCachedQuotas();
  let codexLimits = cached.codex;
  const staleNote = cached.stale ? " (stale)" : "";

  const isOrchCodex = isCodexModel(config.orchestratorModel, config.orchestratorProvider);
  const isWorkerCodex = isCodexModel(config.workerModel, config.workerProvider);
  // Every provider the crew draws on: the lead, the shared worker and each role.
  const targets = activeTargets(config);
  const roleUses = (provider) => targets.some((t) => t.provider === provider);

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
  const orchSub = planLabel(config.orchestratorProvider, config.orchestratorModel, isOrchCodex ? codexLimits : null);
  const workerSub = planLabel(config.workerProvider, config.workerModel, isWorkerCodex ? codexLimits : null);

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

  // 1. Query Codex live rate limits if any subscription role uses Codex (API roles skip).
  if ((isOrchCodex && !isOrchApi) || (isWorkerCodex && !isWorkerApi) || roleUses("codex")) {
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

  /** The weekly window Codex and Claude report next to their 5-hour one. */
  const renderWeekly = (limits) => {
    const weekly = limits?.secondary;
    if (!weekly || typeof weekly.usedPercent !== "number") return;
    const left = Math.max(0, 100 - weekly.usedPercent);
    console.log(`    ${"Weekly Remaining:".padEnd(24)}${progressBar(left, 14)}${weekly.resetFormatted ? ` (resets ${weekly.resetFormatted})` : ""}`);
  };

  // Render Orchestrator Limits (subscription Codex only; API roles already rendered above).
  if (!isOrchApi && isOrchCodex && codexLimits) {
    const orchPeriod = codexLimits.windowMinutes
      ? codexLimits.windowMinutes <= 360 ? "5-Hour" : codexLimits.windowMinutes <= 11520 ? "Weekly" : "Monthly"
      : ((codexLimits.resetsAt - Date.now() / 1000) / 86400 > 8 ? "Monthly" : "Weekly");
    console.log(`  ${c.bold}Orchestrator (${orchSub}):${c.reset}`);
    console.log(`    ${`${orchPeriod} Remaining:`.padEnd(24)}${progressBar(codexLimits.remainingPercent, 14)}`);
    console.log(`    ${"Reset Time:".padEnd(24)}${c.brightYellow}${codexLimits.resetFormatted}${c.reset}`);
    renderWeekly(codexLimits);

    if (codexLimits.creditsAvailable > 0) {
      console.log(`    ${"Reset Credits:".padEnd(24)}${c.brightGreen}${codexLimits.creditsAvailable} reset available${c.reset}`);
    } else {
      console.log(`    ${"Reset Credits:".padEnd(24)}${c.gray}0 resets available${c.reset}`);
    }
    console.log(separator(64));
  }

  // 2. Antigravity usage and health, only when some role runs on Antigravity.
  const usesAgy = roleUses("antigravity");
  let agyHealth = null;
  let agyUsage = null;
  if (usesAgy) {
    // One usage query serves both: it is the quota and the login check.
    const freshAgy = await getAgyUsage().catch(() => null);
    agyHealth = await checkAgyHealth({ usage: freshAgy }).catch((e) => ({ authenticated: false, error: e.message }));
    if (freshAgy) agyUsage = freshAgy;
  }

  saveCachedQuotas(codexLimits, agyUsage);

  // Claude Code reports its account's limits with every turn; Kumo keeps the
  // last report. Asking for fresh ones would mean running a model turn.
  const claudeLimits = cached.orchestrators?.claude || null;

  /**
   * Antigravity's figures for a model. Gemini models also show Gemini 4
   * Argon's own limit next to the family one; an Argon model lists it first.
   *
   * @param {object} usage
   * @param {string} model
   */
  const renderAgyUsage = (usage, model) => {
    const claudeOrGpt = /claude|gpt|anthropic/i.test(model || "");
    const gemini = [["Weekly", usage.geminiWeeklyPercent, usage.geminiWeeklyResetFormatted], ["5-Hour", usage.gemini5HourPercent, usage.gemini5HourResetFormatted]];
    const argon = [["Argon Weekly", usage.geminiArgonWeeklyPercent, usage.geminiArgonWeeklyResetFormatted], ["Argon 5-Hour", usage.geminiArgon5HourPercent, usage.geminiArgon5HourResetFormatted]];
    const rows = claudeOrGpt
      ? [["Weekly", usage.claudeGptWeeklyPercent, usage.claudeGptWeeklyResetFormatted], ["5-Hour", usage.claudeGpt5HourPercent, usage.claudeGpt5HourResetFormatted]]
      : isArgonModel(model) ? [...argon, ...gemini] : [...gemini, ...argon];
    for (const [label, percent, reset] of rows) {
      if (percent === null || percent === undefined) continue;
      console.log(`    ${`${label} Remaining:`.padEnd(24)}${progressBar(percent, 14)} (${reset || label.toLowerCase()})`);
    }
  };

  const renderClaude = () => {
    const bin = findClaudeBinary();
    const installed = path.isAbsolute(bin) && fs.existsSync(bin);
    console.log(
      `    ${"Claude Code:".padEnd(24)}${installed ? `${badge.ok} ${c.gray}${bin}${c.reset}` : `${badge.warn} 'claude' was not found on PATH`}`
    );
    if (claudeLimits?.remainingPercent !== undefined) {
      const period = claudeLimits.windowMinutes <= 360 ? "5-Hour" : "Weekly";
      console.log(`    ${`${period} Remaining:`.padEnd(24)}${progressBar(claudeLimits.remainingPercent, 14)} (resets ${claudeLimits.resetFormatted})`);
      renderWeekly(claudeLimits);
      console.log(`    ${c.gray}From the last Claude turn${staleNote}.${c.reset}`);
    } else {
      console.log(`    ${c.gray}Usage is reported after the first Claude turn.${c.reset}`);
    }
  };

  // Orchestrator on Antigravity or Claude Code (Codex and API roles rendered above).
  if (config.orchestratorProvider === "antigravity") {
    console.log(`  ${c.bold}Orchestrator (${orchSub}):${c.reset}`);
    if (agyUsage) renderAgyUsage(agyUsage, config.orchestratorModel);
    console.log(separator(64));
  } else if (config.orchestratorProvider === "claude") {
    console.log(`  ${c.bold}Orchestrator (${orchSub}):${c.reset}`);
    renderClaude();
    console.log(separator(64));
  }

  // Worker (API workers already rendered above; never fall through to subscription).
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
      renderWeekly(codexLimits);
    }
  } else if (config.workerProvider === "claude") {
    console.log(`  ${c.bold}Worker Provider (${workerSub}):${c.reset}`);
    renderClaude();
  } else if (config.workerProvider === "antigravity") {
    console.log(`  ${c.bold}Worker Provider (${workerSub}):${c.reset}`);
    if (agyHealth?.authenticated) {
      console.log(`    ${"Health:".padEnd(24)}${badge.ok} Connected & Authenticated`);
      console.log(`    ${"Binary:".padEnd(24)}${c.gray}${agyHealth.binary}${c.reset}`);
    } else {
      console.log(`    ${"Health:".padEnd(24)}${badge.warn} ${agyHealth?.installed === false ? "agy not found" : "CLI available, check login"}`);
      if (agyHealth?.error) console.log(`    ${"Detail:".padEnd(24)}${c.gray}${agyHealth.error.slice(0, 100)}${c.reset}`);
    }
    if (agyUsage) renderAgyUsage(agyUsage, config.workerModel);
  } else {
    console.log(`  ${c.bold}Worker Provider (${workerSub}):${c.reset}`);
    console.log(`    ${c.gray}This provider reports no quota to Kumo.${c.reset}`);
  }

  // Providers only roles run on (e.g. a builder on Codex, a researcher on
  // Gemini 4 Argon): their accounts' limits too, once per provider.
  const roleOnly = targets.filter(
    (t) => t.role !== "orchestrator" && t.role !== "worker" && t.provider !== config.orchestratorProvider && t.provider !== config.workerProvider
  );
  const roleNames = (provider) => roleOnly.filter((t) => t.provider === provider).map((t) => `${t.role}: ${t.model || "default"}`).join(", ");
  if (["codex", "claude", "antigravity"].some((p) => roleNames(p))) console.log(separator(64));
  if (roleNames("codex")) {
    console.log(`  ${c.bold}Codex roles (${roleNames("codex")}):${c.reset}`);
    if (codexLimits) {
      const period = codexLimits.windowMinutes && codexLimits.windowMinutes > 360 ? "Weekly" : "5-Hour";
      console.log(`    ${`${period} Remaining:`.padEnd(24)}${progressBar(codexLimits.remainingPercent, 14)} (resets ${codexLimits.resetFormatted})`);
      renderWeekly(codexLimits);
    } else {
      console.log(`    ${c.gray}Codex limits are unavailable.${c.reset}`);
    }
  }
  if (roleNames("claude")) {
    console.log(`  ${c.bold}Claude roles (${roleNames("claude")}):${c.reset}`);
    renderClaude();
  }
  if (roleNames("antigravity")) {
    console.log(`  ${c.bold}Antigravity roles (${roleNames("antigravity")}):${c.reset}`);
    if (agyUsage) {
      const models = [...new Set(roleOnly.filter((t) => t.provider === "antigravity").map((t) => t.model || ""))];
      // An Argon role leads with Argon's limit; Gemini rows list it second.
      renderAgyUsage(agyUsage, models.find((m) => isArgonModel(m)) || models[0]);
    } else {
      console.log(`    ${c.gray}Antigravity usage is unavailable (${agyHealth?.installed === false ? "agy not found" : "check login"}).${c.reset}`);
    }
  }

  console.log(separator(64) + "\n");
}
