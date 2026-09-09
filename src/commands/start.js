/**
 * start.js — Independent interactive terminal UI (REPL) for KUMO.
 * Runs Codex and Antigravity purely in the background via hidden channels,
 * providing clean streaming output, live dual-provider quotas, 30-second banner refreshes,
 * and in-session model & reasoning controls.
 */

import path from "node:path";
import readline from "node:readline";
import { loadConfig, setConfigValue, PRESETS, applyPreset } from "../config/settings.js";
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

/**
 * Render the startup header with cloud cumulus kanji banner and live dual-provider quotas.
 * Formats every line with a clean 20-character label and 14-block progress bars.
 */
function renderHeader(workspace, config, codexLimits = null, agyUsage = null) {
  const sub = `${c.brightCyan}${config.orchestratorModel}${c.reset} ${c.dim}◄───[MCP]───►${c.reset} ${c.brightBlue}${config.workerModel}${c.reset}`;

  console.log("\n" + getBanner("1.0.0", "cloud", sub));
  console.log(separator(64));

  // Blueish gradient sequence for metadata labels matching the banner & separator
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

  // Orchestrator quota line (standard 14 blocks)
  if (codexLimits) {
    const bar = progressBar(codexLimits.remainingPercent, 14);
    const plan = codexLimits.planType ? ` [${codexLimits.planType}]` : "";
    console.log(
      `  ${g2}${"Orchestrator Quota:".padEnd(20)}${c.reset}${bar} ${c.dim}• Resets ${codexLimits.resetFormatted}${plan}${c.reset}`
    );
  }

  // Worker quotas (each on its own line with 14 blocks and exact reset date)
  if (agyUsage) {
    const isClaude = config.workerProvider === "claude";
    const workerLabel = isClaude ? "Claude" : "Gemini";

    // Worker Weekly limit
    const weeklyPercent = isClaude
      ? (agyUsage.claudeGptWeeklyPercent ?? agyUsage.geminiWeeklyPercent)
      : (agyUsage.geminiWeeklyPercent ?? agyUsage.claudeGptWeeklyPercent);
    const weeklyReset = isClaude
      ? (agyUsage.claudeGptWeeklyResetFormatted || "weekly")
      : (agyUsage.geminiWeeklyResetFormatted || "weekly");

    if (weeklyPercent !== null && weeklyPercent !== undefined) {
      const wBar = progressBar(weeklyPercent, 14);
      console.log(
        `  ${g3}${"Worker Weekly:".padEnd(20)}${c.reset}${wBar} ${c.dim}• Resets ${weeklyReset} [${workerLabel}]${c.reset}`
      );
    }

    // Worker 5-Hour limit
    const fiveHourPercent = isClaude
      ? (agyUsage.claudeGpt5HourPercent ?? agyUsage.gemini5HourPercent)
      : (agyUsage.gemini5HourPercent ?? agyUsage.claudeGpt5HourPercent);
    const fiveHourReset = isClaude
      ? (agyUsage.claudeGpt5HourResetFormatted || "5-hour")
      : (agyUsage.gemini5HourResetFormatted || "5-hour");

    if (fiveHourPercent !== null && fiveHourPercent !== undefined) {
      const hBar = progressBar(fiveHourPercent, 14);
      console.log(
        `  ${g3}${"Worker 5-Hour:".padEnd(20)}${c.reset}${hBar} ${c.dim}• Resets ${fiveHourReset} [${workerLabel}]${c.reset}`
      );
    }

    // Additional Claude & GPT pool if not main worker and present
    if (!isClaude && agyUsage.claudeGptWeeklyPercent !== null) {
      const cBar = progressBar(agyUsage.claudeGptWeeklyPercent, 14);
      const cReset = agyUsage.claudeGptWeeklyResetFormatted || "weekly";
      console.log(
        `  ${g4}${"Claude & GPT Pool:".padEnd(20)}${c.reset}${cBar} ${c.dim}• Resets ${cReset} [Agy Pool]${c.reset}`
      );
    }
  }

  console.log(`  ${g4}${"Auth:".padEnd(20)}${c.reset}${c.dim}Subscription credentials (Zero API keys)${c.reset}`);
  console.log(separator(64));
  console.log(
    `  ${c.dim}Commands: ${c.cyan}/help${c.dim}, ${c.cyan}/status${c.dim}, ${c.cyan}/model <name>${c.dim}, ${c.cyan}/effort <level>${c.dim}, ${c.cyan}/clear${c.dim}, ${c.cyan}/exit${c.reset}`
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
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;Kumo — ${path.basename(workspace)}\x07`);
  }

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

      // Update window title with live metrics
      if (process.stdout.isTTY) {
        const cP = codexLimits ? `${codexLimits.remainingPercent}%` : "";
        const gP = agyUsage?.geminiWeeklyPercent !== null ? `${agyUsage.geminiWeeklyPercent}%` : "";
        process.stdout.write(
          `\x1b]0;Kumo [Codex: ${cP} | Gemini: ${gP}] — ${path.basename(workspace)}\x07`
        );
      }
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

        if (process.stdout.isTTY) {
          const cP = codexLimits ? `${codexLimits.remainingPercent}%` : "";
          const gP = agyUsage?.geminiWeeklyPercent !== null ? `${agyUsage.geminiWeeklyPercent}%` : "";
          process.stdout.write(
            `\x1b]0;Kumo [Codex: ${cP} | Gemini: ${gP}] — ${path.basename(workspace)}\x07`
          );
        }

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
          console.log(`\n  ${c.bold}KUMO Interactive Commands:${c.reset}`);
          console.log(`    ${c.cyan}/status${c.reset}, ${c.cyan}/quota${c.reset}          Show live Codex and Antigravity quotas`);
          console.log(`    ${c.cyan}/model [name]${c.reset}           Inspect or switch orchestrator/worker model`);
          console.log(`    ${c.cyan}/effort <level>${c.reset}         Set reasoning effort (low, medium, high, max)`);
          console.log(`    ${c.cyan}/reasoning <level>${c.reset}      Alias for /effort`);
          console.log(`    ${c.cyan}/clear${c.reset}                  Clear console screen and re-render cloud banner`);
          console.log(`    ${c.cyan}/refresh${c.reset}                Re-query orchestrator and worker quotas`);
          console.log(`    ${c.cyan}/help${c.reset}                   Display this help message`);
          console.log(`    ${c.cyan}/exit${c.reset}                   Quit session cleanly\n`);
          rl.prompt();
          return;

        case "model":
          if (!arg1) {
            console.log(`\n  ${c.bold}Active Model Configuration:${c.reset}`);
            console.log(`    ${c.dim}Orchestrator:${c.reset} ${c.brightCyan}${config.orchestratorModel}${c.reset} (reasoning: ${config.reasoningEffort})`);
            console.log(`    ${c.dim}Worker:${c.reset}       ${c.brightBlue}${config.workerModel}${c.reset}\n`);
            console.log(`  ${c.dim}To switch:${c.reset}`);
            console.log(`    ${c.cyan}/model <model-name>${c.reset}             (switch orchestrator model)`);
            console.log(`    ${c.cyan}/model worker <model-name>${c.reset}      (switch worker model)\n`);
            rl.prompt();
            return;
          }

          if (arg1 === "worker" && arg2) {
            config.workerModel = arg2;
            setConfigValue("workerModel", arg2);
            console.log(`\n${badge.ok} Worker model switched to ${c.brightBlue}${arg2}${c.reset}\n`);
            rl.prompt();
            return;
          }

          const newModel = (arg1 === "orchestrator" && arg2) ? arg2 : arg1;
          config.orchestratorModel = newModel;
          setConfigValue("orchestratorModel", newModel);

          try {
            await client.startThread({
              workspace,
              model: newModel,
              reasoningEffort: config.reasoningEffort,
            });
            console.log(`\n${badge.ok} Orchestrator switched to ${c.brightCyan}${newModel}${c.reset} (reasoning: ${config.reasoningEffort})\n`);
          } catch (e) {
            console.log(`\n${badge.warn} Switched model in settings, thread update: ${e.message}\n`);
          }
          rl.prompt();
          return;

        case "effort":
        case "reasoning":
          if (!arg1) {
            console.log(`\n  ${c.dim}Current reasoning effort:${c.reset} ${c.brightCyan}${config.reasoningEffort || "low"}${c.reset}`);
            console.log(`  ${c.dim}Available:${c.reset} low, medium, high, max`);
            console.log(`  ${c.dim}Usage:${c.reset} /effort <level>\n`);
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

          try {
            await client.startThread({
              workspace,
              model: config.orchestratorModel,
              reasoningEffort: effortLevel,
            });
            console.log(`\n${badge.ok} Reasoning effort set to ${c.brightCyan}${effortLevel}${c.reset}\n`);
          } catch (e) {
            console.log(`\n${badge.warn} Saved effort to config: ${e.message}\n`);
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
              console.log(`    ${c.bold}Orchestrator (${codexLimits.planType}):${c.reset}`);
              console.log(`      Monthly Remaining: ${progressBar(codexLimits.remainingPercent, 14)}`);
              console.log(`      Reset Time:        ${c.brightYellow}${codexLimits.resetFormatted}${c.reset}`);
              if (codexLimits.creditsAvailable > 0) {
                console.log(`      Reset Credits:     ${c.brightGreen}${codexLimits.creditsAvailable} reset available${c.reset}`);
              }
            }
            if (agyUsage) {
              console.log(`    ${c.bold}Worker (Antigravity / Google AI Pro):${c.reset}`);
              if (agyUsage.geminiWeeklyPercent !== null) {
                console.log(`      Weekly Remaining:  ${progressBar(agyUsage.geminiWeeklyPercent, 14)} (${agyUsage.geminiWeeklyResetFormatted})`);
              }
              if (agyUsage.gemini5HourPercent !== null) {
                console.log(`      5-Hour Remaining:  ${progressBar(agyUsage.gemini5HourPercent, 14)} (${agyUsage.gemini5HourResetFormatted})`);
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
            console.log(`  ${badge.ok} Quotas refreshed: Codex ${codexLimits?.remainingPercent ?? 0}% remaining • Gemini ${agyUsage?.geminiWeeklyPercent ?? 0}% weekly\n`);
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
