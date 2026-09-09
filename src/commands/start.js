/**
 * start.js — Independent interactive terminal UI (REPL) for KUMO.
 * Runs Codex and Antigravity purely in the background via hidden channels,
 * providing clean streaming output, live dual-provider quotas, 30-second banner refreshes,
 * and in-session model & reasoning controls.
 */

import path from "node:path";
import readline from "node:readline";
import {
  loadConfig,
  setConfigValue,
  PRESETS,
  applyPreset,
  resolveOrchestratorModel,
  resolveWorkerModel,
} from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { getAgyUsage } from "../../bridge/agy-runner.js";
import { launchInNewWindow } from "../utils/window-launcher.js";
import { getCachedQuotas, saveCachedQuotas } from "../utils/quota-cache.js";
import {
  getBanner,
  c,
  badge,
  separator,
  progressBar,
} from "../utils/ui.js";
import { openInteractiveModelPicker } from "../utils/model-picker.js";

function getOrchestratorPeriod(limits) {
  if (!limits) return "Monthly";
  if (limits.windowMinutes) {
    if (limits.windowMinutes <= 360) return "5-Hour";
    if (limits.windowMinutes <= 1440) return "Daily";
    if (limits.windowMinutes <= 11520) return "Weekly";
    return "Monthly";
  }
  if (limits.resetsAt) {
    const diffSec = limits.resetsAt - Math.floor(Date.now() / 1000);
    const diffDays = diffSec / 86400;
    if (diffDays > 8) return "Monthly";
    if (diffDays > 1) return "Weekly";
    if (diffSec <= 21600) return "5-Hour";
    return "Daily";
  }
  return "Monthly";
}

function setKumoTitle() {
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b]0;KUMO — 雲\x07");
  }
}

/**
 * Render the startup header with cloud cumulus kanji banner and live dual-provider quotas.
 * Formats every line with a clean 24-character label and 14-block progress bars.
 */
function renderHeader(workspace, config, codexLimits = null, agyUsage = null) {
  const orchModelFull = config.reasoningEffort ? `${config.orchestratorModel}-${config.reasoningEffort}` : config.orchestratorModel;
  const workerModelFull = config.workerEffort ? `${config.workerModel}-${config.workerEffort}` : config.workerModel;

  const sub = `${c.brightCyan}${orchModelFull}${c.reset} ${c.skyBlue}◄───[MCP]───►${c.reset} ${c.brightBlue}${workerModelFull}${c.reset}`;

  console.log("\n" + getBanner("1.0.0", "cloud", sub));
  console.log(separator(64));

  // Luminous blueish gradient sequence for metadata labels matching the banner & separator
  const g1 = c.brightCyan;
  const g2 = c.cyan;
  const g3 = c.brightBlue;
  const g4 = c.skyBlue;

  const orchSub = codexLimits?.planType || (config.orchestratorProvider === "codex" ? "ChatGPT Plus" : "Codex");

  console.log(`  ${g1}${"Workspace:".padEnd(24)}${c.reset}${workspace}`);
  console.log(
    `  ${g1}${"Orchestrator:".padEnd(24)}${c.reset}${c.brightCyan}${orchModelFull}${c.reset}${c.gray} (${orchSub})${c.reset}`
  );
  console.log(
    `  ${g2}${"Worker:".padEnd(24)}${c.reset}${c.brightBlue}${workerModelFull}${c.reset}${c.gray} (Google AI Pro)${c.reset}`
  );

  // Orchestrator quota line (standard 14 blocks)
  if (codexLimits) {
    const bar = progressBar(codexLimits.remainingPercent, 14);
    const orchPeriod = getOrchestratorPeriod(codexLimits);
    const orchLabel = `Orchestrator ${orchPeriod}:`.padEnd(24);
    console.log(
      `  ${g2}${orchLabel}${c.reset}${bar} ${c.gray}• Resets ${codexLimits.resetFormatted}${c.reset}`
    );
  }

  // Worker quotas strictly for the active worker model
  if (agyUsage) {
    const isClaudeOrGpt = /claude|gpt|anthropic/i.test(config.workerModel) || config.workerProvider === "claude";

    const weeklyPercent = isClaudeOrGpt
      ? agyUsage.claudeGptWeeklyPercent
      : agyUsage.geminiWeeklyPercent;
    const weeklyReset = isClaudeOrGpt
      ? (agyUsage.claudeGptWeeklyResetFormatted || "weekly")
      : (agyUsage.geminiWeeklyResetFormatted || "weekly");

    if (weeklyPercent !== null && weeklyPercent !== undefined) {
      const wBar = progressBar(weeklyPercent, 14);
      console.log(
        `  ${g3}${"Worker Weekly:".padEnd(24)}${c.reset}${wBar} ${c.gray}• Resets ${weeklyReset}${c.reset}`
      );
    }

    const fiveHourPercent = isClaudeOrGpt
      ? agyUsage.claudeGpt5HourPercent
      : agyUsage.gemini5HourPercent;
    const fiveHourReset = isClaudeOrGpt
      ? (agyUsage.claudeGpt5HourResetFormatted || "5-hour")
      : (agyUsage.gemini5HourResetFormatted || "5-hour");

    if (fiveHourPercent !== null && fiveHourPercent !== undefined) {
      const hBar = progressBar(fiveHourPercent, 14);
      console.log(
        `  ${g3}${"Worker 5-Hour:".padEnd(24)}${c.reset}${hBar} ${c.gray}• Resets ${fiveHourReset}${c.reset}`
      );
    }
  }

  console.log(separator(64));
  console.log(`  ${c.bold}${c.brightCyan}How to Work with KUMO:${c.reset}`);
  console.log(`  ${c.gray}1.${c.reset} Type any coding task, architecture query, or bug fix below.`);
  console.log(`  ${c.gray}2.${c.reset} Orchestrator ${c.brightCyan}(${orchModelFull})${c.reset} scopes the plan and breaks down steps.`);
  console.log(`  ${c.gray}3.${c.reset} Worker ${c.brightBlue}(${workerModelFull})${c.reset} executes exploration, edits, and tests via MCP.`);
  console.log(`  ${c.gray}4.${c.reset} Type ${c.cyan}/model${c.reset} to switch models interactively using arrow keys.`);
  console.log("");
  console.log(`  ${c.skyBlue}Examples to try:${c.reset}`);
  console.log(`    ${c.gray}›${c.reset} Explore src/ and outline the application architecture`);
  console.log(`    ${c.gray}›${c.reset} Refactor the authentication handler and add unit tests`);
  console.log(`    ${c.gray}›${c.reset} Run npm test and fix any failing test cases`);
  console.log(separator(64));
  console.log(
    `  ${c.gray}Commands:${c.reset} ${c.cyan}/model${c.reset} ${c.gray}(interactive)${c.reset}, ${c.cyan}/effort <level>${c.reset}, ${c.cyan}/status${c.reset}, ${c.cyan}/help${c.reset}, ${c.cyan}/clear${c.reset}, ${c.cyan}/exit${c.reset}`
  );
  console.log(separator(64) + "\n");
}

export async function startCommand(opts = {}) {
  const workspace = path.resolve(opts.dir || process.cwd());
  const config = loadConfig();

  // If not running in child window and not explicitly told to stay here, launch dedicated window
  const shouldNewWindow = !opts.here && process.stdout.isTTY && !process.env.KUMO_HERE;
  if (shouldNewWindow) {
    const launched = launchInNewWindow({
      workspace,
      args: process.argv.slice(2),
    });
    if (launched) return;
  }

  // Set terminal title
  setKumoTitle();

  // Load instant cached quotas for sub-millisecond menu render
  const cached = getCachedQuotas();
  let codexLimits = cached.codex;
  let agyUsage = cached.agy;

  // Render header IMMEDIATELY (<5ms)
  renderHeader(workspace, config, codexLimits, agyUsage);

  const client = new CodexAppClient({
    env: {
      ORCHESTRATOR_WORKSPACE: workspace,
      KUMO_WORKSPACE: workspace,
    },
  });

  let isTurnActive = false;
  let activeToolName = null;
  let quotaInterval = null;

  // Asynchronously initialize background client and fetch fresh live quotas
  (async () => {
    try {
      await client.start();
      await client.startThread({
        workspace,
        model: config.orchestratorModel,
        reasoningEffort: config.reasoningEffort,
      });

      const [liveCodex, liveAgy] = await Promise.all([
        client.getRateLimits().catch(() => null),
        getAgyUsage().catch(() => null),
      ]);

      if (liveCodex) codexLimits = liveCodex;
      if (liveAgy) agyUsage = liveAgy;
      saveCachedQuotas(codexLimits, agyUsage);

      // Update window title
      setKumoTitle();
    } catch (err) {
      console.error(`\n${badge.warn} Background initialization warning: ${err.message}`);
    }
  })();

  /**
   * Start periodic 30-second banner quota refresh once user submits their first prompt.
   */
  function ensureQuotaRefresher() {
    if (quotaInterval) return;

    quotaInterval = setInterval(async () => {
      try {
        const [newCodex, newAgy] = await Promise.all([
          client.getRateLimits().catch(() => null),
          getAgyUsage().catch(() => null),
        ]);
        if (newCodex) codexLimits = newCodex;
        if (newAgy) agyUsage = newAgy;
        saveCachedQuotas(codexLimits, agyUsage);

        setKumoTitle();

        // If turn is idle at prompt, refresh the screen banner cleanly
        if (!isTurnActive) {
          console.clear();
          renderHeader(workspace, config, codexLimits, agyUsage);
          rl.prompt(true);
        }
      } catch {
        /* ignore background refresh errors */
      }
    }, 30000);
    quotaInterval.unref();
  }

  // Set up event listeners on Codex client
  client.on("delta", (chunk) => {
    process.stdout.write(chunk);
  });

  client.on("reasoning", (_chunk) => {
    // Subtle indicator for background reasoning
  });

  client.on("item_started", (params) => {
    const item = params.item || {};
    if (item.type === "tool_call" || item.type === "dynamic_tool_call" || item.type === "mcp_tool_call") {
      activeToolName = item.name || item.tool || "tool";
      process.stdout.write(`\n  ${c.dim}[worker]${c.reset} ${c.brightCyan}Executing ${activeToolName}...${c.reset}\n`);
    }
  });

  client.on("item_completed", () => {
    if (activeToolName) {
      activeToolName = null;
    }
  });

  client.on("server_error", (err) => {
    console.error(`\n${badge.fail} ${err.message || JSON.stringify(err)}`);
  });

  // Setup Readline REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.brightCyan}${c.bold}kumo${c.reset} ${c.dim}›${c.reset} `,
    terminal: true,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();

    if (isTurnActive) {
      return;
    }

    if (!input) {
      rl.prompt();
      return;
    }

    // Command dispatch
    if (input.startsWith("/")) {
      const parts = input.slice(1).split(" ").filter(Boolean);
      const cmd = (parts[0] || "").toLowerCase();
      const arg1 = parts[1];
      const arg2 = parts[2];

      switch (cmd) {
        case "help":
          console.log(`\n  ${c.bold}${c.brightCyan}KUMO — Cross-Provider AI Orchestrator${c.reset}`);
          console.log(separator(60));
          console.log(`  ${c.bold}How Orchestration Works:${c.reset}`);
          console.log(`  • ${c.brightCyan}Orchestrator (${config.orchestratorModel}):${c.reset} Scopes architecture, plans steps, reviews diffs.`);
          console.log(`  • ${c.brightBlue}Worker (${config.workerModel}):${c.reset} Reads files, writes code, and executes tests via MCP.`);
          console.log(`  • Grunt execution saves orchestrator quota and accelerates iterations.`);
          console.log("");
          console.log(`  ${c.bold}Interactive Commands:${c.reset}`);
          console.log(`    ${c.cyan}/model${c.reset}                 Browse and select models/presets with arrow keys`);
          console.log(`    ${c.cyan}/model <name>${c.reset}          Quick-switch orchestrator model`);
          console.log(`    ${c.cyan}/model worker <name>${c.reset}   Quick-switch worker model`);
          console.log(`    ${c.cyan}/effort <level>${c.reset}         Set orchestrator reasoning effort (low, medium, high, max)`);
          console.log(`    ${c.cyan}/effort worker <lvl>${c.reset}    Set worker reasoning effort (low, medium, high)`);
          console.log(`    ${c.cyan}/status${c.reset}, ${c.cyan}/quota${c.reset}          Show live rate limits and quota progress bars`);
          console.log(`    ${c.cyan}/refresh${c.reset}                Re-fetch live quotas from Codex and Antigravity`);
          console.log(`    ${c.cyan}/clear${c.reset}                  Clear console screen and re-render header`);
          console.log(`    ${c.cyan}/exit${c.reset}                   Quit interactive session cleanly`);
          console.log(separator(60) + "\n");
          rl.prompt();
          return;

        case "model":
          if (!arg1) {
            if (process.stdout.isTTY && process.stdin.isTTY) {
              rl.pause();
              try {
                const oldOrch = config.orchestratorModel;
                const oldEffort = config.reasoningEffort;
                const oldWorker = config.workerModel;
                const oldWorkerEffort = config.workerEffort;
                const updated = await openInteractiveModelPicker({
                  onConfigChanged: async (up) => {
                    Object.assign(config, up);
                  },
                });
                Object.assign(config, updated);

                const changed =
                  oldOrch !== config.orchestratorModel ||
                  oldEffort !== config.reasoningEffort ||
                  oldWorker !== config.workerModel ||
                  oldWorkerEffort !== config.workerEffort;

                if (changed) {
                  console.clear();
                  renderHeader(workspace, config, codexLimits, agyUsage);
                  console.log(
                    `  ${badge.ok} Switched to Orchestrator ${c.brightCyan}${config.orchestratorModel}-${config.reasoningEffort}${c.reset} • Worker ${c.brightBlue}${config.workerModel}-${config.workerEffort || "medium"}${c.reset}\n`
                  );
                }

                setKumoTitle();

                // If orchestrator model or effort changed, restart thread
                if (oldOrch !== config.orchestratorModel || oldEffort !== config.reasoningEffort) {
                  try {
                    await client.startThread({
                      workspace,
                      model: config.orchestratorModel,
                      reasoningEffort: config.reasoningEffort,
                    });
                  } catch (e) {
                    console.log(`  ${badge.warn} Thread update note: ${e.message}`);
                  }
                }
              } finally {
                rl.resume();
                rl.prompt();
              }
              return;
            }

            console.log(`\n  ${c.bold}Active Model Configuration:${c.reset}`);
            console.log(`    ${c.gray}Orchestrator:${c.reset} ${c.brightCyan}${config.orchestratorModel}-${config.reasoningEffort}${c.reset}`);
            console.log(`    ${c.gray}Worker:${c.reset}       ${c.brightBlue}${config.workerModel}-${config.workerEffort || "medium"}${c.reset}\n`);
            console.log(`  ${c.gray}To switch:${c.reset}`);
            console.log(`    ${c.cyan}/model <model-name>${c.reset}                  (switch orchestrator model)`);
            console.log(`    ${c.cyan}/model worker <model-name> [effort]${c.reset}  (switch worker model & effort)\n`);
            rl.prompt();
            return;
          }

          if (arg1 === "worker" && arg2) {
            const resolvedWorker = resolveWorkerModel(arg2);
            config.workerModel = resolvedWorker;
            setConfigValue("workerModel", resolvedWorker);
            if (parts[3]) {
              config.workerEffort = parts[3].toLowerCase();
              setConfigValue("workerEffort", parts[3].toLowerCase());
            }
            console.clear();
            renderHeader(workspace, config, codexLimits, agyUsage);
            console.log(`  ${badge.ok} Worker switched to ${c.brightBlue}${resolvedWorker}-${config.workerEffort || 'medium'}${c.reset}\n`);
            setKumoTitle();
            rl.prompt();
            return;
          }

          const rawTarget = (arg1 === "orchestrator" && arg2) ? arg2 : arg1;
          if (PRESETS[rawTarget]) {
            applyPreset(rawTarget);
            Object.assign(config, loadConfig());
            console.clear();
            renderHeader(workspace, config, codexLimits, agyUsage);
            console.log(`  ${badge.ok} Applied preset '${rawTarget}': Orchestrator ${c.brightCyan}${config.orchestratorModel}-${config.reasoningEffort}${c.reset} • Worker ${c.brightBlue}${config.workerModel}-${config.workerEffort || "medium"}${c.reset}\n`);
            setKumoTitle();
            try {
              await client.startThread({
                workspace,
                model: config.orchestratorModel,
                reasoningEffort: config.reasoningEffort,
              });
            } catch (e) {
              console.log(`  ${badge.warn} Thread update note: ${e.message}`);
            }
            rl.prompt();
            return;
          }

          const resolvedOrch = resolveOrchestratorModel(rawTarget);
          config.orchestratorModel = resolvedOrch;
          setConfigValue("orchestratorModel", resolvedOrch);
          console.clear();
          renderHeader(workspace, config, codexLimits, agyUsage);
          console.log(`  ${badge.ok} Orchestrator switched to ${c.brightCyan}${resolvedOrch}-${config.reasoningEffort}${c.reset}\n`);
          setKumoTitle();

          try {
            await client.startThread({
              workspace,
              model: resolvedOrch,
              reasoningEffort: config.reasoningEffort,
            });
          } catch (e) {
            console.log(`  ${badge.warn} Thread update note: ${e.message}`);
          }
          rl.prompt();
          return;

        case "effort":
        case "reasoning":
          if (arg1 === "worker") {
            if (!arg2) {
              console.log(`\n  ${c.dim}Current worker reasoning effort:${c.reset} ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
              console.log(`  ${c.dim}Available:${c.reset} low, medium, high`);
              console.log(`  ${c.dim}Usage:${c.reset} /effort worker <low|medium|high>\n`);
              rl.prompt();
              return;
            }
            const wEffort = arg2.toLowerCase();
            if (!["low", "medium", "high"].includes(wEffort)) {
              console.log(`\n${badge.warn} Invalid worker effort '${arg2}'. Supported: low, medium, high\n`);
              rl.prompt();
              return;
            }
            config.workerEffort = wEffort;
            setConfigValue("workerEffort", wEffort);
            console.clear();
            renderHeader(workspace, config, codexLimits, agyUsage);
            console.log(`  ${badge.ok} Worker reasoning effort set to ${c.brightBlue}${wEffort}${c.reset}\n`);
            rl.prompt();
            return;
          }

          if (!arg1) {
            console.log(`\n  ${c.dim}Current orchestrator reasoning effort:${c.reset} ${c.brightCyan}${config.reasoningEffort || "low"}${c.reset}`);
            console.log(`  ${c.dim}Current worker reasoning effort:${c.reset}       ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
            console.log(`  ${c.dim}Usage:${c.reset} /effort <low|medium|high|max>`);
            console.log(`         /effort worker <low|medium|high>\n`);
            rl.prompt();
            return;
          }

          const effortLevel = arg1.toLowerCase();
          const validEfforts = ["low", "medium", "high", "max"];
          if (!validEfforts.includes(effortLevel)) {
            console.log(`\n${badge.warn} Invalid effort '${arg1}'. Supported: ${validEfforts.join(", ")}\n`);
            rl.prompt();
            return;
          }

          config.reasoningEffort = effortLevel;
          setConfigValue("reasoningEffort", effortLevel);
          console.clear();
          renderHeader(workspace, config, codexLimits, agyUsage);
          console.log(`  ${badge.ok} Orchestrator reasoning effort set to ${c.brightCyan}${effortLevel}${c.reset}\n`);

          try {
            await client.startThread({
              workspace,
              model: config.orchestratorModel,
              reasoningEffort: effortLevel,
            });
          } catch (e) {
            console.log(`  ${badge.warn} Thread update note: ${e.message}`);
          }
          rl.prompt();
          return;

        case "clear":
        case "cls":
          console.clear();
          renderHeader(workspace, config, codexLimits, agyUsage);
          rl.prompt();
          return;

        case "status":
        case "limits":
        case "quota":
        case "usage":
          try {
            [codexLimits, agyUsage] = await Promise.all([
              client.getRateLimits().catch(() => null),
              getAgyUsage().catch(() => null),
            ]);
            saveCachedQuotas(codexLimits, agyUsage);

            console.log(`\n  ${c.bold}Live Account Quotas & Remaining Limits:${c.reset}`);
            if (codexLimits) {
              const plan = codexLimits.planType ? ` [${codexLimits.planType}]` : "";
              console.log(`    ${c.bold}Orchestrator (${config.orchestratorModel})${plan}:${c.reset}`);
              console.log(`      Monthly Remaining: ${progressBar(codexLimits.remainingPercent, 14)}`);
              console.log(`      Reset Time:        ${c.brightYellow}${codexLimits.resetFormatted}${c.reset}`);
              if (codexLimits.creditsAvailable > 0) {
                console.log(`      Reset Credits:     ${c.brightGreen}${codexLimits.creditsAvailable} reset available${c.reset}`);
              }
            }
            if (agyUsage) {
              const isClaudeOrGpt = /claude|gpt|anthropic/i.test(config.workerModel) || config.workerProvider === "claude";
              const weeklyPercent = isClaudeOrGpt ? agyUsage.claudeGptWeeklyPercent : agyUsage.geminiWeeklyPercent;
              const weeklyReset = isClaudeOrGpt ? (agyUsage.claudeGptWeeklyResetFormatted || "weekly") : (agyUsage.geminiWeeklyResetFormatted || "weekly");
              const fiveHourPercent = isClaudeOrGpt ? agyUsage.claudeGpt5HourPercent : agyUsage.gemini5HourPercent;
              const fiveHourReset = isClaudeOrGpt ? (agyUsage.claudeGpt5HourResetFormatted || "5-hour") : (agyUsage.gemini5HourResetFormatted || "5-hour");

              console.log(`    ${c.bold}Worker Provider (${config.workerModel}):${c.reset}`);
              if (weeklyPercent !== null && weeklyPercent !== undefined) {
                console.log(`      Weekly Remaining:  ${progressBar(weeklyPercent, 14)} (${weeklyReset}) [${config.workerModel}]`);
              }
              if (fiveHourPercent !== null && fiveHourPercent !== undefined) {
                console.log(`      5-Hour Remaining:  ${progressBar(fiveHourPercent, 14)} (${fiveHourReset}) [${config.workerModel}]`);
              }
            }
            console.log("");
          } catch (e) {
            console.log(`\n  ${badge.warn} Failed to refresh limits: ${e.message}\n`);
          }
          rl.prompt();
          return;

        case "refresh":
          try {
            [codexLimits, agyUsage] = await Promise.all([
              client.getRateLimits().catch(() => null),
              getAgyUsage().catch(() => null),
            ]);
            saveCachedQuotas(codexLimits, agyUsage);
            const isClaudeOrGpt = /claude|gpt|anthropic/i.test(config.workerModel) || config.workerProvider === "claude";
            const wPercent = isClaudeOrGpt ? (agyUsage?.claudeGptWeeklyPercent ?? 0) : (agyUsage?.geminiWeeklyPercent ?? 0);
            console.log(`  ${badge.ok} Quotas refreshed: ${config.orchestratorModel} ${codexLimits?.remainingPercent ?? 0}% remaining • ${config.workerModel} ${wPercent}% weekly\n`);
          } catch (e) {
            console.log(`  ${badge.warn} Refresh failed: ${e.message}\n`);
          }
          rl.prompt();
          return;

        case "exit":
        case "quit":
        case "q":
          console.log(`\n${badge.info} Exiting Kumo session.`);
          if (quotaInterval) clearInterval(quotaInterval);
          await client.stop();
          process.exit(0);
          return;

        default:
          console.log(`  ${badge.warn} Unknown command '/${cmd}'. Type ${c.cyan}/help${c.reset} for available commands.`);
          rl.prompt();
          return;
      }
    }

    // Regular task prompt: start 30-second quota refresher once first prompt is made
    ensureQuotaRefresher();

    isTurnActive = true;
    rl.pause();
    process.stdout.write("\n");

    try {
      await client.startTurn(input, {
        model: config.orchestratorModel,
        effort: config.reasoningEffort,
      });

      // Wait for turn completion event
      await new Promise((resolve) => {
        const handler = () => {
          client.off("turn_completed", handler);
          resolve();
        };
        client.on("turn_completed", handler);
      });

      // Refresh quotas post-turn
      [codexLimits, agyUsage] = await Promise.all([
        client.getRateLimits().catch(() => null),
        getAgyUsage().catch(() => null),
      ]);
      saveCachedQuotas(codexLimits, agyUsage);
    } catch (err) {
      console.error(`\n${badge.fail} Turn failed: ${err.message}`);
    } finally {
      isTurnActive = false;
      console.log("\n");
      rl.resume();
      rl.prompt();
    }
  });

  // Handle Ctrl+C
  let sigintCount = 0;
  rl.on("SIGINT", async () => {
    if (isTurnActive) {
      console.log(`\n  ${badge.warn} Interrupting active task...`);
      await client.interruptTurn();
      isTurnActive = false;
      rl.resume();
      rl.prompt();
      return;
    }

    sigintCount++;
    if (sigintCount === 1) {
      console.log(`\n  ${c.dim}Press Ctrl+C again or type /exit to quit.${c.reset}`);
      rl.prompt();
      setTimeout(() => {
        sigintCount = 0;
      }, 2000);
    } else {
      console.log(`\n${badge.info} Goodbye.`);
      if (quotaInterval) clearInterval(quotaInterval);
      await client.stop();
      process.exit(0);
    }
  });

  rl.on("close", async () => {
    if (quotaInterval) clearInterval(quotaInterval);
    await client.stop();
    process.exit(0);
  });
}
