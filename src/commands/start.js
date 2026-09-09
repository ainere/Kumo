/**
 * start.js — Independent interactive terminal UI (REPL) for KUMO.
 * Runs Codex and Gemini/Agy purely in the background via hidden channels,
 * providing clean streaming output, live rate limits, and custom commands.
 */

import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "../config/settings.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { launchInNewWindow } from "../utils/window-launcher.js";
import {
  getBanner,
  c,
  badge,
  separator,
  progressBar,
  DEFAULT_SUBTITLE,
} from "../utils/ui.js";

/**
 * Render the startup header with cloud banner and live rate limits.
 */
function renderHeader(workspace, config, limits = null) {
  const style = config.bannerStyle || "cloud";
  const sub = `${config.orchestratorModel} ◄───[MCP]───► ${config.workerModel}`;

  console.log("\n" + getBanner("1.0.0", style, sub));
  console.log(separator(64));
  console.log(`  ${c.dim}Workspace:${c.reset}    ${workspace}`);
  console.log(
    `  ${c.dim}Orchestrator:${c.reset} ${c.brightCyan}${config.orchestratorModel}${c.reset} (${config.orchestratorProvider || "codex"}, reasoning: ${config.reasoningEffort})`
  );
  console.log(
    `  ${c.dim}Worker:${c.reset}       ${c.brightBlue}${config.workerModel}${c.reset} (${config.workerProvider || "gemini"} via MCP Bridge)`
  );

  if (limits) {
    const bar = progressBar(limits.usedPercent, 12);
    console.log(
      `  ${c.dim}Quota:${c.reset}        ${bar} ${c.dim}• Resets ${limits.resetFormatted} (${limits.planType})${c.reset}`
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

  // If new window requested and not explicitly running here
  if (opts.newWindow && !opts.here) {
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

  // Initial spinner while connecting to background Codex
  process.stdout.write(`\n  ${c.dim}Initializing background orchestrator...${c.reset}\r`);
  const client = new CodexAppClient({
    env: {
      ORCHESTRATOR_WORKSPACE: workspace,
      KUMO_WORKSPACE: workspace,
    },
  });

  let limits = null;
  try {
    await client.start();
    limits = await client.getRateLimits();
    await client.startThread({
      workspace,
      model: config.orchestratorModel,
      reasoningEffort: config.reasoningEffort,
    });
  } catch (err) {
    process.stdout.write(`\r${" ".repeat(60)}\r`);
    console.error(`\n${badge.fail} Failed to initialize background orchestrator: ${err.message}`);
    console.error(`  Make sure Codex CLI is installed and logged in ('codex login').\n`);
    process.exit(1);
  }

  process.stdout.write(`\r${" ".repeat(60)}\r`);
  renderHeader(workspace, config, limits);

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
      const arg = parts.slice(1).join(" ").trim();

      switch (cmd) {
        case "help":
          console.log(`\n  ${c.bold}KUMO Interactive Commands:${c.reset}`);
          console.log(`    ${c.cyan}/status${c.reset}        Show live usage limits, reset countdown & quota`);
          console.log(`    ${c.cyan}/clear${c.reset}         Clear console screen and re-render cloud banner`);
          console.log(`    ${c.cyan}/refresh${c.reset}       Re-query orchestrator status and quota`);
          console.log(`    ${c.cyan}/banner [name]${c.reset} Preview or switch cloud banner style`);
          console.log(`    ${c.cyan}/help${c.reset}          Display this help message`);
          console.log(`    ${c.cyan}/exit${c.reset}          Quit session cleanly\n`);
          rl.prompt();
          return;

        case "clear":
        case "cls":
          console.clear();
          renderHeader(workspace, config, limits);
          rl.prompt();
          return;

        case "status":
        case "limits":
          try {
            process.stdout.write(`  ${c.dim}Fetching live quota...${c.reset}\r`);
            limits = await client.getRateLimits();
            process.stdout.write("\r\x1b[2K");
            console.log(`\n  ${c.bold}Account Usage (${limits.planType}):${c.reset}`);
            console.log(`    Usage:       ${progressBar(limits.usedPercent, 16)}`);
            console.log(`    Reset Time:  ${c.brightYellow}${limits.resetFormatted}${c.reset}`);
            if (limits.creditsAvailable > 0) {
              console.log(`    Credits:     ${c.brightGreen}${limits.creditsAvailable} reset available${c.reset}`);
            }
            console.log("");
          } catch (e) {
            console.log(`\n  ${badge.warn} Failed to refresh limits: ${e.message}\n`);
          }
          rl.prompt();
          return;

        case "refresh":
          try {
            process.stdout.write(`  ${c.dim}Refreshing session...${c.reset}\r`);
            limits = await client.getRateLimits();
            process.stdout.write("\r\x1b[2K");
            console.log(`  ${badge.ok} Quota refreshed: ${limits.usedPercent}% used • Resets ${limits.resetFormatted}\n`);
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
