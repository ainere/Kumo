/**
 * start.js — Independent interactive terminal UI (REPL) for KUMO.
 * Runs Codex and Antigravity purely in the background via hidden channels,
 * providing clean streaming output, live dual-provider quotas, 30-second silent refreshes,
 * and in-session model & reasoning controls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  loadConfig,
  setConfigValue,
  PRESETS,
  applyPreset,
  resolveOrchestratorModel,
  resolveWorkerModel,
  isCodexModel,
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
import { openInteractiveModelPicker, promptSelect } from "../utils/model-picker.js";
import { createSpinner } from "../utils/spinner.js";
import { loadHistory, saveHistory, cleanHistory, clearHistory } from "../utils/history.js";
import { runOnboarding } from "./onboarding.js";
import {
  registerProject,
  createChat,
  appendTurn,
  updateChat,
  listChats,
  listProjects,
  generateChatTitle,
  loadTurnLog,
} from "../data/sessions.js";

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

function setKumoTitle(ws) {
  if (process.stdout.isTTY) {
    const projectName = path.basename(ws || process.cwd());
    process.stdout.write(`\x1b]0;KUMO — ${projectName}\x07`);
  }
}

function getSmartExamples(ws) {
  const examples = [];
  const exists = (p) => fs.existsSync(path.join(ws, p));

  // Detect project type
  const srcDir = exists("src") ? "src/" : exists("lib") ? "lib/" : exists("app") ? "app/" : null;
  if (srcDir) {
    examples.push(`Explore ${srcDir} and outline the application architecture`);
  } else {
    examples.push("Explore the codebase and outline the application architecture");
  }

  // Detect test runner
  if (exists("package.json")) {
    examples.push("Run npm test and fix any failing test cases");
  } else if (exists("pyproject.toml") || exists("setup.py")) {
    examples.push("Run pytest and fix any failing test cases");
  } else if (exists("Cargo.toml")) {
    examples.push("Run cargo test and fix any failing test cases");
  } else if (exists("go.mod")) {
    examples.push("Run go test ./... and fix any failing test cases");
  } else {
    examples.push("Run the test suite and fix any failures");
  }

  // Git / review suggestion
  examples.push("Review the most recent git changes for issues or refactoring");

  return examples;
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

  const isOrchCodex = isCodexModel(config.orchestratorModel, config.orchestratorProvider);
  const isWorkerCodex = isCodexModel(config.workerModel, config.workerProvider);

  const orchSub = isOrchCodex
    ? (codexLimits?.planType || (config.orchestratorProvider === "codex" ? "ChatGPT Plus" : "Codex"))
    : (/claude|anthropic/i.test(config.orchestratorModel)
      ? "Anthropic via Antigravity"
      : /gpt|openai/i.test(config.orchestratorModel)
      ? "OpenAI via Antigravity"
      : "Google AI Pro");

  const workerSub = isWorkerCodex
    ? (codexLimits?.planType || (config.workerProvider === "codex" ? "ChatGPT Plus" : "Codex"))
    : (/claude|anthropic/i.test(config.workerModel)
      ? "Anthropic via Antigravity"
      : /gpt|openai/i.test(config.workerModel)
      ? "OpenAI via Antigravity"
      : "Google AI Pro");

  console.log(`  ${g1}${"Workspace:".padEnd(24)}${c.reset}${workspace}`);
  console.log(
    `  ${g1}${"Orchestrator:".padEnd(24)}${c.reset}${c.brightCyan}${orchModelFull}${c.reset}${c.gray} (${orchSub})${c.reset}`
  );
  console.log(
    `  ${g2}${"Worker:".padEnd(24)}${c.reset}${c.brightBlue}${workerModelFull}${c.reset}${c.gray} (${workerSub})${c.reset}`
  );

  // 1. Orchestrator quota line
  if (isOrchCodex) {
    if (codexLimits) {
      const bar = progressBar(codexLimits.remainingPercent, 14);
      const orchPeriod = getOrchestratorPeriod(codexLimits);
      const orchLabel = `Orchestrator ${orchPeriod}:`.padEnd(24);
      console.log(
        `  ${g2}${orchLabel}${c.reset}${bar} ${c.gray}• Resets ${codexLimits.resetFormatted}${c.reset}`
      );
    }
  } else if (agyUsage) {
    const isClaudeOrGpt = /claude|anthropic/i.test(config.orchestratorModel);
    const weeklyPercent = isClaudeOrGpt ? agyUsage.claudeGptWeeklyPercent : agyUsage.geminiWeeklyPercent;
    const weeklyReset = isClaudeOrGpt ? (agyUsage.claudeGptWeeklyResetFormatted || "weekly") : (agyUsage.geminiWeeklyResetFormatted || "weekly");
    if (weeklyPercent !== null && weeklyPercent !== undefined) {
      const wBar = progressBar(weeklyPercent, 14);
      console.log(`  ${g2}${"Orchestrator Weekly:".padEnd(24)}${c.reset}${wBar} ${c.gray}• Resets ${weeklyReset}${c.reset}`);
    }
    const fiveHourPercent = isClaudeOrGpt ? agyUsage.claudeGpt5HourPercent : agyUsage.gemini5HourPercent;
    const fiveHourReset = isClaudeOrGpt ? (agyUsage.claudeGpt5HourResetFormatted || "5-hour") : (agyUsage.gemini5HourResetFormatted || "5-hour");
    if (fiveHourPercent !== null && fiveHourPercent !== undefined) {
      const hBar = progressBar(fiveHourPercent, 14);
      console.log(`  ${g2}${"Orchestrator 5-Hour:".padEnd(24)}${c.reset}${hBar} ${c.gray}• Resets ${fiveHourReset}${c.reset}`);
    }
  }

  // 2. Worker quota line
  if (isWorkerCodex) {
    if (codexLimits) {
      const bar = progressBar(codexLimits.remainingPercent, 14);
      const workerPeriod = getOrchestratorPeriod(codexLimits);
      const workerLabel = `Worker ${workerPeriod}:`.padEnd(24);
      console.log(
        `  ${g3}${workerLabel}${c.reset}${bar} ${c.gray}• Resets ${codexLimits.resetFormatted}${c.reset}`
      );
    }
  } else if (agyUsage) {
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
  for (const ex of getSmartExamples(workspace)) {
    console.log(`    ${c.gray}›${c.reset} ${ex}`);
  }
  console.log(separator(64));
  console.log(
    `  ${c.gray}Commands:${c.reset} ${c.cyan}/model${c.reset}, ${c.cyan}/preset${c.reset}, ${c.cyan}/new${c.reset}, ${c.cyan}/chats${c.reset}, ${c.cyan}/projects${c.reset}, ${c.cyan}/status${c.reset}, ${c.cyan}/help${c.reset}`
  );
  console.log(separator(64) + "\n");
}

export async function startCommand(opts = {}) {
  let currentWorkspace = path.resolve(opts.dir || process.cwd());

  // Check for first-run onboarding
  const configPath = path.join(os.homedir(), ".kumo", "config.json");
  if (!fs.existsSync(configPath)) {
    await runOnboarding();
  }

  let config = loadConfig();

  // If not running in child window and not explicitly told to stay here, launch dedicated window
  const shouldNewWindow = !opts.here && process.stdout.isTTY && !process.env.KUMO_HERE;
  if (shouldNewWindow) {
    const launched = launchInNewWindow({
      workspace: currentWorkspace,
      args: process.argv.slice(2),
    });
    if (launched) return;
  }

  // Register project & start session
  registerProject(currentWorkspace);
  let currentChatId = createChat(currentWorkspace, {
    model: config.orchestratorModel,
    effort: config.reasoningEffort,
  });
  let turnCount = 0;

  // Set terminal title
  setKumoTitle(currentWorkspace);

  // Load instant cached quotas for sub-millisecond menu render
  const cached = getCachedQuotas();
  let codexLimits = cached.codex;
  let agyUsage = cached.agy;

  // Render header IMMEDIATELY (<5ms)
  renderHeader(currentWorkspace, config, codexLimits, agyUsage);

  const client = new CodexAppClient({
    env: {
      ORCHESTRATOR_WORKSPACE: currentWorkspace,
      KUMO_WORKSPACE: currentWorkspace,
    },
  });

  let isTurnActive = false;
  let activeToolName = null;
  let quotaInterval = null;
  const spinner = createSpinner("Thinking");

  // Asynchronously initialize background client and fetch fresh live quotas
  (async () => {
    try {
      await client.start();
      await client.startThread({
        workspace: currentWorkspace,
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
      setKumoTitle(currentWorkspace);
    } catch (err) {
      console.error(`\n${badge.warn} Background initialization warning: ${err.message}`);
    }
  })();

  /**
   * Start periodic 30-second silent banner quota refresh once user submits their first prompt.
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

        setKumoTitle(currentWorkspace);
      } catch {
        /* ignore background refresh errors */
      }
    }, 30000);
    quotaInterval.unref();
  }

  // Set up event listeners on Codex client
  client.on("delta", (chunk) => {
    spinner.stop();
    process.stdout.write(chunk);
  });

  client.on("reasoning", () => {
    if (!spinner.isActive()) {
      spinner.start();
    }
  });

  client.on("turn_completed", () => {
    spinner.stop();
  });

  client.on("item_started", (params) => {
    const item = params.item || {};
    if (item.type === "tool_call" || item.type === "dynamic_tool_call" || item.type === "mcp_tool_call") {
      activeToolName = item.name || item.tool || "tool";

      let taskPreview = "";
      const args = item.arguments || item.input || {};
      if (typeof args === "string") {
        try {
          const parsed = JSON.parse(args);
          taskPreview = parsed.task || "";
        } catch {
          taskPreview = args;
        }
      } else {
        taskPreview = args.task || "";
      }

      const truncated = taskPreview.length > 80 ? taskPreview.slice(0, 77) + "..." : taskPreview;
      const taskDisplay = truncated ? `\n    ${c.dim}${truncated}${c.reset}` : "";

      spinner.stop();
      process.stdout.write(`\n  ${c.dim}[worker]${c.reset} ${c.brightCyan}${activeToolName}${c.reset}${taskDisplay}\n`);
    }
  });

  client.on("item_completed", () => {
    if (activeToolName) {
      activeToolName = null;
    }
  });

  client.on("server_error", (err) => {
    spinner.stop();
    console.error(`\n${badge.fail} ${err.message || JSON.stringify(err)}`);
  });

  client.on("close", async (code) => {
    if (isTurnActive) {
      spinner.stop();
      isTurnActive = false;
      console.error(`\n  ${badge.fail} Orchestrator process exited unexpectedly (code ${code}).`);
      console.log(`  ${c.dim}Attempting to reconnect...${c.reset}`);

      try {
        await client.start();
        await client.startThread({
          workspace: currentWorkspace,
          model: config.orchestratorModel,
          reasoningEffort: config.reasoningEffort,
        });
        console.log(`  ${badge.ok} Reconnected.\n`);
      } catch (e) {
        console.error(`  ${badge.fail} Reconnection failed: ${e.message}`);
        console.log(`  ${c.dim}Type any prompt to retry, or /exit to quit.${c.reset}\n`);
      }

      rl.resume();
      rl.prompt();
    }
  });

  // Slash commands for auto-completion
  const SLASH_COMMANDS = [
    "/model",
    "/effort",
    "/preset",
    "/new",
    "/chats",
    "/projects",
    "/cd",
    "/save",
    "/rename",
    "/status",
    "/quota",
    "/usage",
    "/refresh",
    "/clear",
    "/cls",
    "/history",
    "/clear-history",
    "/help",
    "/exit",
    "/quit",
  ];

  function completer(line) {
    if (line.startsWith("/")) {
      const hits = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(line));
      return [hits.length ? hits : SLASH_COMMANDS, line];
    }
    return [[], line];
  }

  // Setup Readline REPL with persistent history and tab completion
  // Filter out non-chat slash commands so prompt cycling only shows user prompts
  const rawHistory = loadHistory();
  const history = rawHistory.filter((line) => !line.trim().startsWith("/"));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.brightCyan}${c.bold}kumo${c.reset} ${c.dim}›${c.reset} `,
    terminal: true,
    history,
    historySize: 500,
    completer,
  });

  const saveReplHistory = () => {
    // Only persist actual prompts, not slash commands or settings tweaks
    const chatOnly = (rl.history || []).filter((line) => !line.trim().startsWith("/"));
    saveHistory(chatOnly);
  };

  async function switchWorkspace(newPath) {
    const resolvedPath = path.resolve(newPath);

    // Save current chat state
    if (currentChatId) {
      updateChat(currentWorkspace, currentChatId, { lastUsedAt: Date.now(), turns: turnCount });
    }

    currentWorkspace = resolvedPath;
    registerProject(currentWorkspace);

    currentChatId = createChat(currentWorkspace, {
      model: config.orchestratorModel,
      effort: config.reasoningEffort,
    });
    turnCount = 0;

    try {
      await client.startThread({
        workspace: currentWorkspace,
        model: config.orchestratorModel,
        reasoningEffort: config.reasoningEffort,
      });
    } catch (e) {
      console.log(`  ${badge.warn} Thread restart note: ${e.message}`);
    }

    console.clear();
    renderHeader(currentWorkspace, config, codexLimits, agyUsage);
    console.log(`  ${badge.ok} Switched to workspace: ${currentWorkspace}\n`);
    setKumoTitle(currentWorkspace);
  }

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
      // Remove slash command from readline history so it doesn't pollute prompt history
      if (rl.history && rl.history[0] === line) {
        rl.history.shift();
      }

      const parts = input.slice(1).split(" ").filter(Boolean);
      const cmd = (parts[0] || "").toLowerCase();
      const arg1 = parts[1];
      const arg2 = parts[2];

      switch (cmd) {
        case "help":
          console.log(`\n  ${c.bold}${c.brightCyan}KUMO — Cross-Provider AI Orchestrator${c.reset}`);
          console.log(separator(64));
          console.log(`  ${c.bold}Session & Workspaces:${c.reset}`);
          console.log(`    ${c.cyan}/new${c.reset}                     Start a fresh conversation thread`);
          console.log(`    ${c.cyan}/chats${c.reset}                   Browse and switch previous conversations`);
          console.log(`    ${c.cyan}/projects${c.reset}                Browse and switch registered workspaces`);
          console.log(`    ${c.cyan}/cd <path>${c.reset}               Switch active workspace directory`);
          console.log(`    ${c.cyan}/rename <title>${c.reset}          Rename current conversation`);
          console.log(`    ${c.cyan}/save [file]${c.reset}             Export conversation transcript to Markdown`);
          console.log("");
          console.log(`  ${c.bold}Models & Reasoning:${c.reset}`);
          console.log(`    ${c.cyan}/model${c.reset}                   Interactive arrow-key model & provider picker`);
          console.log(`    ${c.cyan}/model <name>${c.reset}            Quick-switch orchestrator model`);
          console.log(`    ${c.cyan}/model worker <name>${c.reset}     Quick-switch worker model`);
          console.log(`    ${c.cyan}/preset [name]${c.reset}           Apply or list configuration presets`);
          console.log(`    ${c.cyan}/effort <level>${c.reset}           Set orchestrator effort (low, medium, high, max)`);
          console.log(`    ${c.cyan}/effort worker <lvl>${c.reset}      Set worker effort (low, medium, high)`);
          console.log("");
          console.log(`  ${c.bold}Quotas & Utilities:${c.reset}`);
          console.log(`    ${c.cyan}/status${c.reset}, ${c.cyan}/quota${c.reset}            Show live rate limits and quota progress bars`);
          console.log(`    ${c.cyan}/refresh${c.reset}                  Re-fetch live quotas from Codex and Antigravity`);
          console.log(`    ${c.cyan}/clear${c.reset}, ${c.cyan}/cls${c.reset}             Clear console screen and re-render header`);
          console.log(`    ${c.cyan}/history${c.reset} [clean|clear]     View, clean settings from, or clear prompt history`);
          console.log(`    ${c.cyan}/exit${c.reset}, ${c.cyan}/quit${c.reset}              Quit interactive session cleanly`);
          console.log(separator(64) + "\n");
          rl.prompt();
          return;

        case "history": {
          if (arg1 === "clear") {
            clearHistory();
            if (rl.history) rl.history.length = 0;
            console.log(`  ${badge.ok} Cleared all command and prompt history.\n`);
            rl.prompt();
            return;
          }
          if (arg1 === "clean") {
            const remaining = cleanHistory();
            if (rl.history) {
              rl.history = rl.history.filter((l) => !l.trim().startsWith("/"));
            }
            console.log(`  ${badge.ok} Cleaned non-chat commands from history (${remaining.length} prompts kept).\n`);
            rl.prompt();
            return;
          }
          // Default: display recent prompt history
          const active = (rl.history || []).slice(0, 10);
          if (active.length === 0) {
            console.log(`  ${c.dim}No prompt history available.${c.reset}\n`);
          } else {
            console.log(`\n  ${c.bold}Recent Prompt History:${c.reset}`);
            active.forEach((item, idx) => {
              console.log(`    ${c.gray}${String(idx + 1).padStart(2)}.${c.reset} ${item}`);
            });
            console.log(`\n  ${c.dim}To clean non-chat commands:${c.reset} ${c.cyan}/history clean${c.reset}`);
            console.log(`  ${c.dim}To clear all history:${c.reset}       ${c.cyan}/history clear${c.reset}\n`);
          }
          rl.prompt();
          return;
        }

        case "clear-history": {
          clearHistory();
          if (rl.history) rl.history.length = 0;
          console.log(`  ${badge.ok} Cleared all command and prompt history.\n`);
          rl.prompt();
          return;
        }

        case "preset": {
          if (!arg1) {
            console.log(`\n  ${c.bold}Available Presets:${c.reset}`);
            for (const [key, p] of Object.entries(PRESETS)) {
              const active =
                config.orchestratorModel === p.config.orchestratorModel &&
                config.workerModel === p.config.workerModel &&
                config.reasoningEffort === p.config.reasoningEffort &&
                (config.workerEffort || "medium") === (p.config.workerEffort || "medium")
                  ? ` ${c.brightGreen}[ACTIVE]${c.reset}`
                  : "";
              console.log(`    ${c.cyan}${key.padEnd(14)}${c.reset}${p.description}${active}`);
            }
            console.log(`\n  ${c.dim}Usage:${c.reset} /preset <name>\n`);
            rl.prompt();
            return;
          }
          if (!PRESETS[arg1]) {
            console.log(`  ${badge.warn} Unknown preset '${arg1}'. Available: ${Object.keys(PRESETS).join(", ")}\n`);
            rl.prompt();
            return;
          }
          applyPreset(arg1);
          config = loadConfig();
          console.clear();
          renderHeader(currentWorkspace, config, codexLimits, agyUsage);
          console.log(`  ${badge.ok} Applied preset '${arg1}': Orchestrator ${c.brightCyan}${config.orchestratorModel}-${config.reasoningEffort}${c.reset} • Worker ${c.brightBlue}${config.workerModel}-${config.workerEffort || "medium"}${c.reset}\n`);
          setKumoTitle(currentWorkspace);
          try {
            await client.startThread({
              workspace: currentWorkspace,
              model: config.orchestratorModel,
              reasoningEffort: config.reasoningEffort,
            });
          } catch (e) {
            console.log(`  ${badge.warn} Thread update note: ${e.message}`);
          }
          rl.prompt();
          return;
        }

        case "new": {
          if (currentChatId) {
            updateChat(currentWorkspace, currentChatId, { lastUsedAt: Date.now(), turns: turnCount });
          }
          try {
            await client.startThread({
              workspace: currentWorkspace,
              model: config.orchestratorModel,
              reasoningEffort: config.reasoningEffort,
            });
          } catch (e) {
            console.log(`  ${badge.warn} Thread restart note: ${e.message}`);
          }
          currentChatId = createChat(currentWorkspace, {
            model: config.orchestratorModel,
            effort: config.reasoningEffort,
          });
          turnCount = 0;
          console.clear();
          renderHeader(currentWorkspace, config, codexLimits, agyUsage);
          console.log(`  ${badge.ok} New conversation started.\n`);
          rl.prompt();
          return;
        }

        case "chats": {
          const chats = listChats(currentWorkspace);
          if (chats.length === 0) {
            console.log(`  ${c.dim}No saved chats for this project.${c.reset}\n`);
            rl.prompt();
            return;
          }

          rl.pause();
          try {
            const items = chats.map((chat, i) => ({
              label: chat.title || `Chat ${i + 1}`,
              value: chat.id,
              hint: `${chat.turns || 0} turns • ${new Date(chat.lastUsedAt).toLocaleDateString()}`,
              isCurrent: chat.id === currentChatId,
            }));
            items.push({ label: "← Back to Session", value: "cancel" });

            const chosen = await promptSelect({ title: "Conversations", items });

            if (chosen && chosen !== "cancel" && chosen !== currentChatId) {
              updateChat(currentWorkspace, currentChatId, { lastUsedAt: Date.now(), turns: turnCount });
              currentChatId = chosen;
              const chatMeta = chats.find((c) => c.id === chosen);
              turnCount = chatMeta?.turns || 0;

              try {
                await client.startThread({
                  workspace: currentWorkspace,
                  model: config.orchestratorModel,
                  reasoningEffort: config.reasoningEffort,
                });
              } catch (e) {
                console.log(`  ${badge.warn} Thread restart note: ${e.message}`);
              }

              console.clear();
              renderHeader(currentWorkspace, config, codexLimits, agyUsage);
              console.log(`  ${badge.ok} Switched to: ${chatMeta?.title || chosen}\n`);
            }
          } finally {
            process.stdin.resume();
            if (process.stdin.setRawMode) {
              process.stdin.setRawMode(true);
            }
            rl.line = "";
            rl.cursor = 0;
            rl.resume();
            rl.prompt();
          }
          return;
        }

        case "projects": {
          const projects = listProjects();
          if (projects.length === 0) {
            console.log(`  ${c.dim}No registered projects yet.${c.reset}\n`);
            rl.prompt();
            return;
          }

          rl.pause();
          try {
            const items = projects.map((p) => ({
              label: p.name || path.basename(p.path),
              value: p.path,
              hint: p.path,
              isCurrent: path.resolve(p.path) === path.resolve(currentWorkspace),
            }));
            items.push({ label: "← Back to Session", value: "cancel" });

            const chosen = await promptSelect({ title: "Projects", items });

            if (chosen && chosen !== "cancel" && path.resolve(chosen) !== path.resolve(currentWorkspace)) {
              await switchWorkspace(chosen);
            }
          } finally {
            process.stdin.resume();
            if (process.stdin.setRawMode) {
              process.stdin.setRawMode(true);
            }
            rl.line = "";
            rl.cursor = 0;
            rl.resume();
            rl.prompt();
          }
          return;
        }

        case "cd":
        case "workspace":
        case "open": {
          if (!arg1) {
            console.log(`  ${c.dim}Current workspace:${c.reset} ${currentWorkspace}`);
            console.log(`  ${c.dim}Usage:${c.reset} /cd <path>\n`);
            rl.prompt();
            return;
          }
          const targetPath = path.resolve(arg1);
          if (!fs.existsSync(targetPath)) {
            console.log(`  ${badge.warn} Directory not found: ${targetPath}\n`);
            rl.prompt();
            return;
          }
          await switchWorkspace(targetPath);
          rl.prompt();
          return;
        }

        case "save": {
          const log = loadTurnLog(currentWorkspace, currentChatId);
          if (!log || log.length === 0) {
            console.log(`  ${c.dim}No turns to save in current conversation.${c.reset}\n`);
            rl.prompt();
            return;
          }
          const filename = arg1 || `kumo-session-${new Date().toISOString().slice(0, 10)}.md`;
          const outputPath = path.resolve(currentWorkspace, filename);

          let md = `# Kumo Session — ${new Date().toLocaleDateString()}\n\n`;
          md += `**Workspace:** ${currentWorkspace}\n\n`;
          md += `**Orchestrator:** ${config.orchestratorModel}-${config.reasoningEffort}\n\n`;
          md += `**Worker:** ${config.workerModel}-${config.workerEffort || "medium"}\n\n---\n\n`;

          for (let i = 0; i < log.length; i++) {
            const turn = log[i];
            md += `## Turn ${i + 1} (${new Date(turn.timestamp).toLocaleTimeString()})\n\n`;
            md += `**Prompt:**\n\n${turn.prompt}\n\n`;
            if (turn.responseSummary) {
              md += `**Response:**\n\n${turn.responseSummary}\n\n`;
            }
            md += `*Elapsed: ${((turn.elapsedMs || 0) / 1000).toFixed(1)}s*\n\n---\n\n`;
          }

          try {
            fs.writeFileSync(outputPath, md, "utf-8");
            console.log(`  ${badge.ok} Session saved to ${c.cyan}${outputPath}${c.reset}\n`);
          } catch (e) {
            console.log(`  ${badge.warn} Failed to save session: ${e.message}\n`);
          }
          rl.prompt();
          return;
        }

        case "rename": {
          const newTitle = parts.slice(1).join(" ").trim();
          if (!newTitle) {
            console.log(`  ${c.dim}Usage:${c.reset} /rename <new title>\n`);
            rl.prompt();
            return;
          }
          updateChat(currentWorkspace, currentChatId, { title: newTitle });
          console.log(`  ${badge.ok} Chat renamed to "${newTitle}"\n`);
          rl.prompt();
          return;
        }

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
                  onConfigChanged: async () => {
                    config = loadConfig();
                  },
                });
                config = loadConfig();

                const changed =
                  oldOrch !== config.orchestratorModel ||
                  oldEffort !== config.reasoningEffort ||
                  oldWorker !== config.workerModel ||
                  oldWorkerEffort !== config.workerEffort;

                if (changed) {
                  console.clear();
                  renderHeader(currentWorkspace, config, codexLimits, agyUsage);
                  console.log(
                    `  ${badge.ok} Switched to Orchestrator ${c.brightCyan}${config.orchestratorModel}-${config.reasoningEffort}${c.reset} • Worker ${c.brightBlue}${config.workerModel}-${config.workerEffort || "medium"}${c.reset}\n`
                  );
                }

                setKumoTitle(currentWorkspace);

                // If orchestrator model or effort changed, restart thread
                if (oldOrch !== config.orchestratorModel || oldEffort !== config.reasoningEffort) {
                  try {
                    await client.startThread({
                      workspace: currentWorkspace,
                      model: config.orchestratorModel,
                      reasoningEffort: config.reasoningEffort,
                    });
                  } catch (e) {
                    console.log(`  ${badge.warn} Thread update note: ${e.message}`);
                  }
                }
              } finally {
                process.stdin.resume();
                if (process.stdin.setRawMode) {
                  process.stdin.setRawMode(true);
                }
                rl.line = "";
                rl.cursor = 0;
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
            const isCodex = isCodexModel(resolvedWorker);
            config.workerProvider = isCodex ? "codex" : "gemini";
            setConfigValue("workerModel", resolvedWorker);
            setConfigValue("workerProvider", config.workerProvider);
            if (parts[3]) {
              config.workerEffort = parts[3].toLowerCase();
              setConfigValue("workerEffort", parts[3].toLowerCase());
            }
            config = loadConfig();
            console.clear();
            renderHeader(currentWorkspace, config, codexLimits, agyUsage);
            console.log(`  ${badge.ok} Worker switched to ${c.brightBlue}${resolvedWorker}-${config.workerEffort || 'medium'}${c.reset}\n`);
            setKumoTitle(currentWorkspace);
            rl.prompt();
            return;
          }

          const rawTarget = (arg1 === "orchestrator" && arg2) ? arg2 : arg1;
          if (PRESETS[rawTarget]) {
            applyPreset(rawTarget);
            config = loadConfig();
            console.clear();
            renderHeader(currentWorkspace, config, codexLimits, agyUsage);
            console.log(`  ${badge.ok} Applied preset '${rawTarget}': Orchestrator ${c.brightCyan}${config.orchestratorModel}-${config.reasoningEffort}${c.reset} • Worker ${c.brightBlue}${config.workerModel}-${config.workerEffort || "medium"}${c.reset}\n`);
            setKumoTitle(currentWorkspace);
            try {
              await client.startThread({
                workspace: currentWorkspace,
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
          const isOrch = isCodexModel(resolvedOrch);
          config.orchestratorProvider = isOrch ? "codex" : "gemini";
          setConfigValue("orchestratorModel", resolvedOrch);
          setConfigValue("orchestratorProvider", config.orchestratorProvider);
          config = loadConfig();
          console.clear();
          renderHeader(currentWorkspace, config, codexLimits, agyUsage);
          console.log(`  ${badge.ok} Orchestrator switched to ${c.brightCyan}${resolvedOrch}-${config.reasoningEffort}${c.reset}\n`);
          setKumoTitle(currentWorkspace);

          try {
            await client.startThread({
              workspace: currentWorkspace,
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
            config = loadConfig();
            console.clear();
            renderHeader(currentWorkspace, config, codexLimits, agyUsage);
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
          config = loadConfig();
          console.clear();
          renderHeader(currentWorkspace, config, codexLimits, agyUsage);
          console.log(`  ${badge.ok} Orchestrator reasoning effort set to ${c.brightCyan}${effortLevel}${c.reset}\n`);

          try {
            await client.startThread({
              workspace: currentWorkspace,
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
          renderHeader(currentWorkspace, config, codexLimits, agyUsage);
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
          saveReplHistory();
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

    const turnStart = Date.now();
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
      spinner.stop();
      isTurnActive = false;

      const elapsed = ((Date.now() - turnStart) / 1000).toFixed(1);
      console.log(`\n  ${c.dim}✓ Completed in ${elapsed}s${c.reset}\n`);

      turnCount++;
      appendTurn(currentWorkspace, currentChatId, {
        prompt: input,
        responseSummary: null,
        timestamp: Date.now(),
        model: config.orchestratorModel,
        elapsedMs: Date.now() - turnStart,
      });
      updateChat(currentWorkspace, currentChatId, {
        lastUsedAt: Date.now(),
        turns: turnCount,
      });
      if (turnCount === 1) {
        updateChat(currentWorkspace, currentChatId, {
          title: generateChatTitle(input),
        });
      }

      saveReplHistory();
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
      saveReplHistory();
      if (quotaInterval) clearInterval(quotaInterval);
      await client.stop();
      process.exit(0);
    }
  });

  rl.on("close", async () => {
    saveReplHistory();
    if (quotaInterval) clearInterval(quotaInterval);
    await client.stop();
    process.exit(0);
  });
}
