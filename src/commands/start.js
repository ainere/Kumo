/**
 * start.js — Independent interactive terminal UI (REPL) for KUMO.
 * Runs Codex and Antigravity purely in the background via hidden channels,
 * providing clean streaming output, live dual-provider quotas, and custom commands.
 */

import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { getAgyUsage } from "../../bridge/agy-runner.js";
import { launchInNewWindow } from "../utils/window-launcher.js";
import {
  getBanner,
  c,
  badge,
  separator,
  progressBar,
} from "../utils/ui.js";

/**
 * Render the startup header with cloud cumulus kanji banner and live dual-provider quotas.
 */
function renderHeader(workspace, config, codexLimits = null, agyUsage = null) {
  const sub = `${config.orchestratorModel} ◄───[MCP]───► ${config.workerModel}`;

  console.log("\n" + getBanner("1.0.0", "cloud", sub));
  console.log(separator(64));
  console.log(`  ${c.dim}Workspace:${c.reset}    ${workspace}`);
  console.log(
    `  ${c.dim}Orchestrator:${c.reset} ${c.brightCyan}${config.orchestratorModel}${c.reset} (${config.orchestratorProvider || "codex"}, reasoning: ${config.reasoningEffort})`
  );
  console.log(
    `  ${c.dim}Worker:${c.reset}       ${c.brightBlue}${config.workerModel}${c.reset} (antigravity via MCP Bridge)`
  );

  if (codexLimits) {
    const bar = progressBar(codexLimits.remainingPercent, 12);
    console.log(
      `  ${c.dim}Quota (Codex):${c.reset} ${bar} ${c.dim}• Resets ${codexLimits.resetFormatted} (${codexLimits.planType})${c.reset}`
    );
  }

  if (agyUsage && agyUsage.geminiWeeklyPercent !== null) {
    const wBar = progressBar(agyUsage.geminiWeeklyPercent, 8);
    const hBar = progressBar(agyUsage.gemini5HourPercent ?? 100, 8);
    console.log(
      `  ${c.dim}Quota (Gemini):${c.reset}${wBar} ${c.dim}weekly •${c.reset} ${hBar} ${c.dim}5-hour (Google AI Pro)${c.reset}`
    );
  }

  console.log(`  ${c.dim}Auth:${c.reset}         Subscription credentials (Zero API keys)`);
  console.log(separator(64));
  console.log(
    `  ${c.dim}Type a prompt to begin, or ${c.cyan}/help${c.dim}, ${c.cyan}/status${c.dim}, ${c.cyan}/clear${c.dim}, ${c.cyan}/exit${c.reset}`
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

  const client = new CodexAppClient({
    env: {
      ORCHESTRATOR_WORKSPACE: workspace,
      KUMO_WORKSPACE: workspace,
    },
  });

  let codexLimits = null;
  let agyUsage = null;

  try {
    await client.start();
    [codexLimits, agyUsage] = await Promise.all([
      client.getRateLimits().catch(() => null),
      getAgyUsage().catch(() => null),
    ]);
    await client.startThread({
      workspace,
      model: config.orchestratorModel,
      reasoningEffort: config.reasoningEffort,
    });
  } catch (err) {
    console.error(`\n${badge.fail} Failed to initialize background orchestrator: ${err.message}`);
    console.error(`  Make sure Codex CLI is installed and logged in ('codex login').\n`);
    process.exit(1);
  }

  renderHeader(workspace, config, codexLimits, agyUsage);

  let isTurnActive = false;
  let activeToolName = null;

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

  client.on("item_completed", (params) => {
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
      const parts = input.slice(1).split(" ");
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        case "help":
          console.log(`\n  ${c.bold}KUMO Interactive Commands:${c.reset}`);
          console.log(`    ${c.cyan}/status${c.reset}, ${c.cyan}/quota${c.reset}  Show live Codex and Antigravity quotas`);
          console.log(`    ${c.cyan}/clear${c.reset}         Clear console screen and re-render cloud banner`);
          console.log(`    ${c.cyan}/refresh${c.reset}       Re-query orchestrator and worker quotas`);
          console.log(`    ${c.cyan}/help${c.reset}          Display this help message`);
          console.log(`    ${c.cyan}/exit${c.reset}          Quit session cleanly\n`);
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
            console.log(`\n  ${c.bold}Account Quotas & Remaining Limits:${c.reset}`);
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
          await client.stop();
          process.exit(0);
          return;

        default:
          console.log(`  ${badge.warn} Unknown command '/${cmd}'. Type ${c.cyan}/help${c.reset} for available commands.`);
          rl.prompt();
          return;
      }
    }

    // Regular task prompt
    isTurnActive = true;
    rl.pause();
    process.stdout.write("\n");

    try {
      await client.startTurn(input);
      // Wait for turn completion event
      await new Promise((resolve) => {
        const handler = () => {
          client.off("turn_completed", handler);
          resolve();
        };
        client.on("turn_completed", handler);
      });
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
      await client.stop();
      process.exit(0);
    }
  });

  rl.on("close", async () => {
    await client.stop();
    process.exit(0);
  });
}
