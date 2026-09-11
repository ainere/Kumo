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
import { randomUUID } from "node:crypto";
import {
  loadConfig,
  setConfigValue,
  PRESETS,
  applyPreset,
  resolveOrchestratorModel,
  resolveWorkerModel,
  detectProviderForModel,
  isCodexModel,
} from "../config/settings.js";
import { createOrchestratorClient } from "../providers/orchestrators/registry.js";
import { getAgyUsage } from "../bridge/agy-runner.js";
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
  getLiveLogDir,
  getLiveLogPath,
  getActiveLiveRun,
} from "../data/sessions.js";
import { VERSION } from "../cli.js";

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

  console.log("\n" + getBanner(VERSION, "cloud", sub));
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

  let client = null;
  let isTurnActive = false;
  const activeTools = new Map();
  const streamBuffers = new Map();
  const tailIntervals = new Map();
  let focusedStream = "orchestrator";
  let quotaInterval = null;
  const spinner = createSpinner("Thinking");

  const MAX_BUFFER_LINES = 200;
  function appendToBuffer(streamId, text) {
    if (!streamBuffers.has(streamId)) {
      streamBuffers.set(streamId, []);
    }
    const buf = streamBuffers.get(streamId);
    buf.push(text);
    if (buf.length > MAX_BUFFER_LINES) {
      buf.splice(0, buf.length - MAX_BUFFER_LINES);
    }
  }

  function updateWorkerTitle(toolInfo) {
    if (!process.stdout.isTTY || !isTurnActive) return;
    const elapsed = Math.floor((Date.now() - (toolInfo.startedAt || Date.now())) / 1000);
    const toolModel = toolInfo.model || config.workerModel || "worker";
    const toolName = toolInfo.name || "worker_task";
    const focusHint = focusedStream === toolInfo.id ? "focused" : "Tab to focus";
    process.stdout.write(`\x1b]0;KUMO — [${toolName}: ${toolModel}] ${elapsed}s (${focusHint})\x07`);
  }

  function startTailing(itemId, toolInfo) {
    if (tailIntervals.has(itemId)) return;
    if (!streamBuffers.has(itemId)) {
      streamBuffers.set(itemId, []);
    }

    let offset = 0;
    let fd = null;
    let resolvedLogPath = null;

    const interval = setInterval(() => {
      try {
        if (!resolvedLogPath) {
          const directPath = getLiveLogPath(currentWorkspace, itemId);
          if (fs.existsSync(directPath)) {
            resolvedLogPath = directPath;
          } else {
            const activeRun = getActiveLiveRun(currentWorkspace, toolInfo.runId);
            if (activeRun && activeRun.runId) {
              toolInfo.runId = activeRun.runId;
              const activePath = getLiveLogPath(currentWorkspace, activeRun.runId);
              if (fs.existsSync(activePath)) {
                resolvedLogPath = activePath;
              }
            }
          }
        }

        if (!resolvedLogPath || !fs.existsSync(resolvedLogPath)) {
          updateWorkerTitle(toolInfo);
          return;
        }

        const stat = fs.statSync(resolvedLogPath);
        if (stat.size > offset) {
          if (fd === null) {
            fd = fs.openSync(resolvedLogPath, "r");
          }
          const bytesToRead = stat.size - offset;
          const buf = Buffer.alloc(bytesToRead);
          const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, offset);
          offset += bytesRead;

          if (bytesRead > 0) {
            const chunkStr = buf.toString("utf-8", 0, bytesRead);
            appendToBuffer(itemId, chunkStr);
            if (focusedStream === itemId) {
              process.stdout.write(chunkStr);
            }
          }
        }

        updateWorkerTitle(toolInfo);
      } catch {
        /* ignore transient tailing errors */
      }
    }, 80);

    tailIntervals.set(itemId, {
      interval,
      toolInfo,
      getOffset: () => offset,
      getFd: () => fd,
      getLogPath: () => resolvedLogPath,
      cleanup: () => {
        clearInterval(interval);
        if (fd !== null) {
          try { fs.closeSync(fd); } catch {}
          fd = null;
        }
      },
    });
  }

  function stopTailing(itemId) {
    const tailer = tailIntervals.get(itemId);
    if (!tailer) return;

    tailIntervals.delete(itemId);
    tailer.cleanup();

    const logPath = tailer.getLogPath() || getLiveLogPath(currentWorkspace, itemId);
    if (logPath && fs.existsSync(logPath)) {
      try {
        const stat = fs.statSync(logPath);
        const offset = tailer.getOffset();
        if (stat.size > offset) {
          const fd = fs.openSync(logPath, "r");
          const bytesToRead = stat.size - offset;
          const buf = Buffer.alloc(bytesToRead);
          fs.readSync(fd, buf, 0, bytesToRead, offset);
          fs.closeSync(fd);
          const chunkStr = buf.toString("utf-8");
          appendToBuffer(itemId, chunkStr);
          if (focusedStream === itemId) {
            process.stdout.write(chunkStr);
          }
        }
        try {
          fs.unlinkSync(logPath);
        } catch {}
      } catch {}
    }

    if (focusedStream === itemId) {
      focusedStream = "orchestrator";
      console.log(`\n  ${badge.ok} ${c.dim}[worker] ${tailer.toolInfo?.name || "tool"} finished${c.reset}`);
      console.log(`  ${badge.info} ${c.bold}Focus returned to Orchestrator (${config.orchestratorModel})${c.reset}\n`);
    }

    if (activeTools.size === 0) {
      setKumoTitle(currentWorkspace);
    }
  }

  function cycleStreamFocus() {
    if (!isTurnActive) return;
    const streams = ["orchestrator", ...activeTools.keys()];
    if (streams.length <= 1) return;

    const currentIndex = streams.indexOf(focusedStream);
    const nextIndex = (currentIndex + 1) % streams.length;
    focusedStream = streams[nextIndex];

    spinner.stop();

    if (focusedStream === "orchestrator") {
      const orchModel = config.orchestratorModel;
      console.log(`\n\n  ${badge.info} ${c.bold}Focused on Orchestrator (${orchModel})${c.reset} ${c.dim}(Tab to switch)${c.reset}\n`);
      const recent = (streamBuffers.get("orchestrator") || []).slice(-30).join("");
      if (recent) {
        process.stdout.write(recent);
      }
    } else {
      const tool = activeTools.get(focusedStream);
      const toolName = tool?.name || "worker";
      const toolModel = tool?.model || config.workerModel;
      console.log(`\n\n  ${badge.info} ${c.bold}Focused on Worker: ${toolName} (${toolModel})${c.reset} ${c.dim}(Tab to switch)${c.reset}\n`);
      const recent = (streamBuffers.get(focusedStream) || []).slice(-30).join("");
      if (recent) {
        process.stdout.write(recent);
      }
    }
  }

  function attachClientListeners(cl) {
    cl.on("delta", (chunk) => {
      appendToBuffer("orchestrator", chunk);
      if (focusedStream === "orchestrator") {
        spinner.stop();
        process.stdout.write(chunk);
      }
    });

    cl.on("reasoning", (chunk) => {
      if (chunk) {
        const formatted = `${c.dim}${chunk}${c.reset}`;
        appendToBuffer("orchestrator", formatted);
        if (focusedStream === "orchestrator") {
          spinner.stop();
          process.stdout.write(formatted);
        }
      } else if (!spinner.isActive() && focusedStream === "orchestrator") {
        spinner.start();
      }
    });

    cl.on("turn_completed", () => {
      for (const itemId of activeTools.keys()) {
        stopTailing(itemId);
      }
      activeTools.clear();
      tailIntervals.clear();
      streamBuffers.clear();
      focusedStream = "orchestrator";
      spinner.stop();
      setKumoTitle(currentWorkspace);
    });

    cl.on("item_started", (params) => {
      const item = params?.item || {};
      const itemId = item.id || randomUUID();
      if (item.type === "tool_call" || item.type === "dynamic_tool_call" || item.type === "mcp_tool_call") {
        const toolName = item.name || item.tool || "tool";

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

        const workerModel = (typeof args === "object" && args?.model) || item.model || config.workerModel;
        const workerEffort = (typeof args === "object" && args?.effort) || item.effort || config.workerEffort;

        const toolInfo = {
          id: itemId,
          name: toolName,
          task: taskPreview,
          model: workerModel,
          effort: workerEffort,
          startedAt: Date.now(),
        };

        activeTools.set(itemId, toolInfo);

        let modelDisplay = "";
        if (workerModel) {
          const effortPart = workerEffort ? `, effort: ${workerEffort}` : "";
          modelDisplay = ` ${c.dim}(${workerModel}${effortPart})${c.reset}`;
        }

        const truncated = taskPreview.length > 80 ? taskPreview.slice(0, 77) + "..." : taskPreview;
        const taskDisplay = truncated ? `\n    ${c.dim}${truncated}${c.reset}` : "";

        spinner.stop();
        const headerText = `\n  ${c.dim}[worker]${c.reset} ${c.brightCyan}${toolName}${c.reset}${modelDisplay}${taskDisplay}\n`;
        appendToBuffer("orchestrator", headerText);
        process.stdout.write(headerText);

        startTailing(itemId, toolInfo);
      }
    });

    cl.on("item_completed", (params) => {
      const item = params?.item || {};
      let itemId = item.id;
      if (!itemId && activeTools.size > 0) {
        itemId = activeTools.keys().next().value;
      }
      if (itemId) {
        stopTailing(itemId);
        activeTools.delete(itemId);
      }
    });

    cl.on("server_error", (err) => {
      for (const itemId of activeTools.keys()) {
        stopTailing(itemId);
      }
      activeTools.clear();
      tailIntervals.clear();
      focusedStream = "orchestrator";
      spinner.stop();
      setKumoTitle(currentWorkspace);
      console.error(`\n${badge.fail} ${err.message || JSON.stringify(err)}`);
    });

    cl.on("close", async (code) => {
      if (isTurnActive) {
        for (const itemId of activeTools.keys()) {
          stopTailing(itemId);
        }
        activeTools.clear();
        tailIntervals.clear();
        focusedStream = "orchestrator";
        spinner.stop();
        isTurnActive = false;
        console.error(`\n  ${badge.fail} Orchestrator process exited unexpectedly (code ${code}).`);
        console.log(`  ${c.dim}Attempting to reconnect...${c.reset}`);

        try {
          await initClient();
          console.log(`  ${badge.ok} Reconnected.\n`);
        } catch (e) {
          console.error(`  ${badge.fail} Reconnection failed: ${e.message}`);
          console.log(`  ${c.dim}Type any prompt to retry, or /exit to quit.${c.reset}\n`);
        }

        rl.resume();
        rl.prompt();
      }
    });
  }

  async function initClient() {
    if (client) {
      try {
        await client.stop();
      } catch {}
    }

    client = createOrchestratorClient({
      provider: config.orchestratorProvider || detectProviderForModel(config.orchestratorModel),
      model: config.orchestratorModel,
      effort: config.reasoningEffort,
      workspace: currentWorkspace,
      env: {
        ORCHESTRATOR_WORKSPACE: currentWorkspace,
        KUMO_WORKSPACE: currentWorkspace,
      },
    });

    attachClientListeners(client);
    await client.start();
    await client.startThread({
      workspace: currentWorkspace,
      model: config.orchestratorModel,
      reasoningEffort: config.reasoningEffort,
    });
  }

  // Asynchronously initialize background client and fetch fresh live quotas
  (async () => {
    try {
      await initClient();

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

  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
  }

  const onKeypress = (str, key) => {
    if (!isTurnActive) return;
    if ((key?.ctrl && key?.name === "c") || str === "\u0003") {
      if (isTurnActive) {
        console.log(`\n  ${badge.warn} Interrupting active task...`);
        client.interruptTurn().catch(() => {});
        isTurnActive = false;
      }
      return;
    }
    if (key?.name === "tab" || str === "\t") {
      cycleStreamFocus();
    }
  };
  process.stdin.on("keypress", onKeypress);

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
            config.workerProvider = detectProviderForModel(resolvedWorker);
            setConfigValue("workerModel", resolvedWorker);
            setConfigValue("workerProvider", config.workerProvider);
            if (parts[3]) {
              config.workerEffort = parts[3].toLowerCase();
              setConfigValue("workerEffort", parts[3].toLowerCase());
            }
            config = loadConfig();
            console.clear();
            renderHeader(currentWorkspace, config, codexLimits, agyUsage);
            console.log(`  ${badge.ok} Worker switched to ${c.brightBlue}${resolvedWorker}-${config.workerEffort || 'medium'}${c.reset} [${config.workerProvider}]\n`);
            setKumoTitle(currentWorkspace);
            rl.prompt();
            return;
          }

          const rawTarget = (arg1 === "orchestrator" && arg2) ? arg2 : arg1;
          if (PRESETS[rawTarget]) {
            const oldOrchProv = config.orchestratorProvider;
            applyPreset(rawTarget);
            config = loadConfig();
            console.clear();
            renderHeader(currentWorkspace, config, codexLimits, agyUsage);
            console.log(`  ${badge.ok} Applied preset '${rawTarget}': Orchestrator ${c.brightCyan}${config.orchestratorModel}-${config.reasoningEffort}${c.reset} [${config.orchestratorProvider}] • Worker ${c.brightBlue}${config.workerModel}-${config.workerEffort || "medium"}${c.reset} [${config.workerProvider}]\n`);
            setKumoTitle(currentWorkspace);
            try {
              if (oldOrchProv !== config.orchestratorProvider) {
                await initClient();
              } else if (client) {
                await client.startThread({
                  workspace: currentWorkspace,
                  model: config.orchestratorModel,
                  reasoningEffort: config.reasoningEffort,
                });
              }
            } catch (e) {
              console.log(`  ${badge.warn} Thread update note: ${e.message}`);
            }
            rl.prompt();
            return;
          }

          const resolvedOrch = resolveOrchestratorModel(rawTarget);
          const oldOrchProv = config.orchestratorProvider;
          const newOrchProv = detectProviderForModel(resolvedOrch);
          config.orchestratorModel = resolvedOrch;
          config.orchestratorProvider = newOrchProv;
          setConfigValue("orchestratorModel", resolvedOrch);
          setConfigValue("orchestratorProvider", newOrchProv);
          config = loadConfig();
          console.clear();
          renderHeader(currentWorkspace, config, codexLimits, agyUsage);
          console.log(`  ${badge.ok} Orchestrator switched to ${c.brightCyan}${resolvedOrch}-${config.reasoningEffort}${c.reset} [${newOrchProv}]\n`);
          setKumoTitle(currentWorkspace);

          try {
            if (oldOrchProv !== newOrchProv) {
              await initClient();
            } else if (client) {
              await client.startThread({
                workspace: currentWorkspace,
                model: resolvedOrch,
                reasoningEffort: config.reasoningEffort,
              });
            }
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
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
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
      for (const itemId of activeTools.keys()) {
        stopTailing(itemId);
      }
      activeTools.clear();
      tailIntervals.clear();
      streamBuffers.clear();
      focusedStream = "orchestrator";
      spinner.stop();
      setKumoTitle(currentWorkspace);
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
    process.stdin.removeListener("keypress", onKeypress);
    for (const itemId of activeTools.keys()) {
      stopTailing(itemId);
    }
    saveReplHistory();
    if (quotaInterval) clearInterval(quotaInterval);
    await client.stop();
    process.exit(0);
  });
}
