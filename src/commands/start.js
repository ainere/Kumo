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

/**
 * start.js — Kumo's interactive terminal (REPL), a client of the engine.
 *
 * Everything stateful — the orchestrator, turns, worker calls, approvals,
 * chats and their provider threads, quotas, settings — lives in a Session
 * (src/core/session.js). This file renders its events and turns slash
 * commands into Session calls; the desktop app drives the same Session.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { loadConfig, PRESETS, presetConfig, presetMatches, resolveModel, providerForModel } from "../config/settings.js";
import { EFFORT_LEVELS, planLabel } from "../config/models.js";
import { Session } from "../core/session.js";
import { SESSION_SETTING_KEYS } from "../core/settings.js";
import { launchInNewWindow } from "../utils/window-launcher.js";
import { getBanner, c, badge, separator, progressBar } from "../utils/ui.js";
import { openInteractiveModelPicker, promptSelect } from "../utils/model-picker.js";
import { createSpinner } from "../utils/spinner.js";
import { loadHistory, saveHistory, cleanHistory, clearHistory } from "../utils/history.js";
import { runOnboarding } from "./onboarding.js";
import { roleSetPatch, formatRoles } from "./role.js";
import { BUILTIN_ROLE_IDS, roleAssignment, describeTarget } from "../config/roles.js";
import { listProjects } from "../data/sessions.js";
import { configFile } from "../config/paths.js";
import { VERSION } from "../version.js";

function getQuotaPeriod(limits) {
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

  const srcDir = exists("src") ? "src/" : exists("lib") ? "lib/" : exists("app") ? "app/" : null;
  examples.push(
    srcDir
      ? `Explore ${srcDir} and outline the application architecture`
      : "Explore the codebase and outline the application architecture"
  );

  if (exists("package.json")) examples.push("Run npm test and fix any failing test cases");
  else if (exists("pyproject.toml") || exists("setup.py")) examples.push("Run pytest and fix any failing test cases");
  else if (exists("Cargo.toml")) examples.push("Run cargo test and fix any failing test cases");
  else if (exists("go.mod")) examples.push("Run go test ./... and fix any failing test cases");
  else examples.push("Run the test suite and fix any failures");

  examples.push("Review the most recent git changes for issues or refactoring");
  return examples;
}

/**
 * Antigravity's figures for a model: Claude/GPT models share one pool, Gemini
 * and open-weights models another.
 */
function antigravityLines(usage, model) {
  if (!usage) return [];
  const claudeOrGpt = /claude|gpt|anthropic/i.test(model || "");
  const pick = (weekly) =>
    claudeOrGpt
      ? [weekly ? usage.claudeGptWeeklyPercent : usage.claudeGpt5HourPercent, weekly ? usage.claudeGptWeeklyResetFormatted : usage.claudeGpt5HourResetFormatted]
      : [weekly ? usage.geminiWeeklyPercent : usage.gemini5HourPercent, weekly ? usage.geminiWeeklyResetFormatted : usage.gemini5HourResetFormatted];
  const lines = [];
  for (const [label, weekly] of [["Weekly", true], ["5-Hour", false]]) {
    const [percent, reset] = pick(weekly);
    if (percent !== null && percent !== undefined) lines.push({ label, percent, reset: reset || label.toLowerCase() });
  }
  return lines;
}

/**
 * The quota lines for one role: the orchestrator client's own limits when
 * the role runs on that provider, Antigravity's usage for Antigravity roles.
 */
function quotaLinesFor(role, settings, quotas) {
  const provider = role === "orchestrator" ? settings.orchestratorProvider : settings.workerProvider;
  const model = role === "orchestrator" ? settings.orchestratorModel : settings.workerModel;
  if (provider === "antigravity") return antigravityLines(quotas.antigravity, model);
  // The orchestrator client reports its provider's account limits; a worker
  // on the same provider draws on the same account.
  if (provider === settings.orchestratorProvider && quotas.orchestrator?.remainingPercent !== undefined) {
    const limits = quotas.orchestrator;
    return [{ label: getQuotaPeriod(limits), percent: limits.remainingPercent, reset: limits.resetFormatted }];
  }
  return [];
}

/**
 * Render the startup header: banner, models, quotas, how-to and examples.
 */
function renderHeader(workspace, settings, quotas) {
  const orchModelFull = settings.reasoningEffort ? `${settings.orchestratorModel}-${settings.reasoningEffort}` : settings.orchestratorModel;
  const workerModelFull = settings.workerEffort ? `${settings.workerModel}-${settings.workerEffort}` : settings.workerModel;

  const sub = `${c.brightCyan}${orchModelFull}${c.reset} ${c.skyBlue}◄───[MCP]───►${c.reset} ${c.brightBlue}${workerModelFull}${c.reset}`;
  console.log("\n" + getBanner(VERSION, "cloud", sub));
  console.log(separator(64));

  const g1 = c.brightCyan;
  const g2 = c.cyan;
  const g3 = c.brightBlue;
  const orchSub = planLabel(settings.orchestratorProvider, settings.orchestratorModel, quotas.orchestrator);
  const workerSub = planLabel(settings.workerProvider, settings.workerModel, settings.workerProvider === settings.orchestratorProvider ? quotas.orchestrator : null);

  console.log(`  ${g1}${"Workspace:".padEnd(24)}${c.reset}${workspace}`);
  console.log(`  ${g1}${"Orchestrator:".padEnd(24)}${c.reset}${c.brightCyan}${orchModelFull}${c.reset}${c.gray} (${orchSub})${c.reset}`);
  console.log(`  ${g2}${"Worker:".padEnd(24)}${c.reset}${c.brightBlue}${workerModelFull}${c.reset}${c.gray} (${workerSub})${c.reset}`);
  // Roles with their own model; the rest run on the worker above.
  const assigned = [...BUILTIN_ROLE_IDS, ...(settings.roles?.custom || []).map((r) => r.id)]
    .map((id) => [id, roleAssignment(settings, id)])
    .filter(([, a]) => a);
  if (assigned.length > 0) {
    const list = assigned
      .map(([id, a]) => `${id} ${c.brightBlue}${a.model}${a.effort ? `-${a.effort}` : ""}${c.reset}`)
      .join(`${c.gray} • ${c.reset}`);
    console.log(`  ${g2}${"Roles:".padEnd(24)}${c.reset}${list}`);
  }

  for (const [role, color, title] of [["orchestrator", g2, "Orchestrator"], ["worker", g3, "Worker"]]) {
    for (const line of quotaLinesFor(role, settings, quotas)) {
      const label = `${title} ${line.label}:`.padEnd(24);
      console.log(`  ${color}${label}${c.reset}${progressBar(line.percent, 14)} ${c.gray}• Resets ${line.reset}${c.reset}`);
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
    `  ${c.gray}Commands:${c.reset} ${c.cyan}/model${c.reset}, ${c.cyan}/role${c.reset}, ${c.cyan}/preset${c.reset}, ${c.cyan}/new${c.reset}, ${c.cyan}/chats${c.reset}, ${c.cyan}/projects${c.reset}, ${c.cyan}/status${c.reset}, ${c.cyan}/help${c.reset}`
  );
  console.log(separator(64) + "\n");
}

const SLASH_COMMANDS = [
  "/model", "/role", "/effort", "/preset", "/new", "/chats", "/projects", "/cd", "/save", "/rename",
  "/status", "/quota", "/usage", "/refresh", "/clear", "/cls", "/history", "/clear-history",
  "/help", "/exit", "/quit",
];

function completer(line) {
  if (line.startsWith("/")) {
    const hits = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(line));
    return [hits.length ? hits : SLASH_COMMANDS, line];
  }
  return [[], line];
}

export async function startCommand(opts = {}) {
  const startDir = path.resolve(opts.dir || process.cwd());

  if (!fs.existsSync(configFile())) {
    await runOnboarding();
  }

  // Unless told to stay here, open Kumo in its own terminal window.
  const shouldNewWindow = !opts.here && process.stdout.isTTY && !process.env.KUMO_HERE;
  if (shouldNewWindow) {
    const launched = await launchInNewWindow({ workspace: startDir, args: process.argv.slice(2) });
    if (launched) return;
  }

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const session = new Session({ workspace: startDir, interactive: tty });
  const ws = () => session.workspace;
  const header = () => renderHeader(ws(), session.settings, session.quotas.snapshot());

  setKumoTitle(ws());
  header();

  // ── turn view state ──
  let isTurnActive = false;
  /** Worker calls of the running turn, in the order they started. */
  const activeTools = new Map();
  /** Recent text per stream ("orchestrator" or a tool id), replayed on Tab. */
  const streamBuffers = new Map();
  let focusedStream = "orchestrator";
  let titleTimer = null;
  const spinner = createSpinner("Thinking");

  // One budget in characters: a chunk count would drop the start of long answers.
  const MAX_BUFFER_CHARS = 200_000;
  function appendToBuffer(streamId, text) {
    if (!streamBuffers.has(streamId)) streamBuffers.set(streamId, []);
    const buf = streamBuffers.get(streamId);
    buf.push(text);
    let total = 0;
    for (const part of buf) total += part.length;
    while (buf.length > 1 && total > MAX_BUFFER_CHARS) total -= buf.shift().length;
  }

  function updateWorkerTitle() {
    if (!process.stdout.isTTY || !isTurnActive || activeTools.size === 0) return;
    const tool = activeTools.get(focusedStream) || [...activeTools.values()].at(-1);
    const elapsed = Math.floor((Date.now() - tool.startedAt) / 1000);
    const focusHint = focusedStream === tool.toolId ? "focused" : "Tab to focus";
    process.stdout.write(`\x1b]0;KUMO — [${tool.name}: ${tool.model || session.settings.workerModel}] ${elapsed}s (${focusHint})\x07`);
  }

  function cycleStreamFocus() {
    if (!isTurnActive) return;
    const streams = ["orchestrator", ...activeTools.keys()];
    if (streams.length <= 1) return;
    focusedStream = streams[(streams.indexOf(focusedStream) + 1) % streams.length];
    spinner.stop();
    if (focusedStream === "orchestrator") {
      console.log(`\n\n  ${badge.info} ${c.bold}Focused on Orchestrator (${session.settings.orchestratorModel})${c.reset} ${c.dim}(Tab to switch)${c.reset}\n`);
    } else {
      const tool = activeTools.get(focusedStream);
      console.log(`\n\n  ${badge.info} ${c.bold}Focused on Worker: ${tool?.name || "worker"} (${tool?.model || session.settings.workerModel})${c.reset} ${c.dim}(Tab to switch)${c.reset}\n`);
    }
    const recent = (streamBuffers.get(focusedStream) || []).slice(-30).join("");
    if (recent) process.stdout.write(recent);
    updateWorkerTitle();
  }

  // ── approvals ──
  // Orchestrator requests and worker write approvals both read one key from
  // the same terminal; they take turns.
  let approvalChain = Promise.resolve();
  function withApprovalLock(fn) {
    const run = approvalChain.then(fn);
    approvalChain = run.catch(() => {});
    return run;
  }

  /**
   * Show a pending change or request and read a single-key decision.
   *
   * @param {{ tool: string, preview: string }} request
   * @returns {Promise<boolean>}
   */
  function askApproval(request) {
    return new Promise((resolve) => {
      const text = String(request.preview || "");
      const lines = text.split("\n");
      const shown = lines.slice(0, 40);
      console.log(`\n  ${badge.warn} ${c.bold}Approval required${c.reset} ${c.dim}(${request.tool})${c.reset}`);
      for (const line of shown) console.log(`    ${c.dim}${line}${c.reset}`);
      if (lines.length > shown.length) {
        console.log(`    ${c.dim}… ${lines.length - shown.length} more lines — press d for the full preview${c.reset}`);
      }
      process.stdout.write(`\n  Approve? ${c.bold}[y/N/d]${c.reset} `);
      const onKey = (str) => {
        const ch = String(str || "").toLowerCase();
        if (ch === "d") {
          process.stdout.write("d\n");
          console.log(text);
          process.stdout.write(`\n  Approve? ${c.bold}[y/N]${c.reset} `);
          return;
        }
        process.stdin.off("keypress", onKey);
        const approved = ch === "y";
        process.stdout.write(`${approved ? "y" : "n"}\n`);
        resolve(approved);
      };
      process.stdin.on("keypress", onKey);
    });
  }

  // ── engine events ──
  session.on("event", (e) => {
    switch (e.type) {
      case "turn.delta":
        appendToBuffer("orchestrator", e.text);
        if (focusedStream === "orchestrator") {
          spinner.stop();
          process.stdout.write(e.text);
        }
        break;
      case "turn.reasoning":
        if (e.text) {
          const formatted = `${c.dim}${e.text}${c.reset}`;
          appendToBuffer("orchestrator", formatted);
          if (focusedStream === "orchestrator") {
            spinner.stop();
            process.stdout.write(formatted);
          }
        } else if (!spinner.isActive() && focusedStream === "orchestrator") {
          spinner.start();
        }
        break;
      case "tool.started": {
        activeTools.set(e.toolId, e);
        const effortPart = e.effort ? `, effort: ${e.effort}` : "";
        const modelDisplay = e.model ? ` ${c.dim}(${e.model}${effortPart})${c.reset}` : "";
        const task = e.task.length > 80 ? e.task.slice(0, 77) + "..." : e.task;
        const taskDisplay = task ? `\n    ${c.dim}${task}${c.reset}` : "";
        spinner.stop();
        const text = `\n  ${c.dim}[${e.role || "worker"}]${c.reset} ${c.brightCyan}${e.name}${c.reset}${modelDisplay}${taskDisplay}\n`;
        appendToBuffer("orchestrator", text);
        process.stdout.write(text);
        updateWorkerTitle();
        break;
      }
      case "tool.output":
        appendToBuffer(e.toolId, e.text);
        if (focusedStream === e.toolId) process.stdout.write(e.text);
        break;
      case "tool.completed": {
        const tool = activeTools.get(e.toolId);
        activeTools.delete(e.toolId);
        if (focusedStream === e.toolId) {
          focusedStream = "orchestrator";
          console.log(`\n  ${badge.ok} ${c.dim}[worker] ${tool?.name || e.name} finished${c.reset}`);
          console.log(`  ${badge.info} ${c.bold}Focus returned to Orchestrator (${session.settings.orchestratorModel})${c.reset}\n`);
        }
        if (activeTools.size === 0) setKumoTitle(ws());
        break;
      }
      case "approval.requested":
        void withApprovalLock(async () => {
          spinner.stop();
          const approved = await askApproval(e);
          session.resolveApproval(e.approvalId, approved);
        }).catch(() => session.resolveApproval(e.approvalId, false));
        break;
      case "session.warning":
        spinner.stop();
        console.log(`\n  ${badge.warn} ${c.dim}${e.message}${c.reset}`);
        break;
      case "session.notice":
        console.log(`  ${badge.info} ${c.dim}${e.message}${c.reset}`);
        break;
      case "session.error":
        console.error(`\n${badge.fail} ${e.message}`);
        break;
      default:
        break;
    }
  });

  // Start in the background; the first prompt waits for it (or retries).
  session.start().catch((err) => {
    console.error(`\n${badge.warn} Background initialization warning: ${err.message}`);
  });

  // ── readline ──
  // Only prompts go into history: slash commands and settings are noise there.
  const history = loadHistory().filter((line) => !line.trim().startsWith("/"));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.brightCyan}${c.bold}kumo${c.reset} ${c.dim}›${c.reset} `,
    terminal: true,
    history,
    historySize: 500,
    completer,
  });
  if (process.stdin.isTTY) readline.emitKeypressEvents(process.stdin);

  let interruptRequested = false;
  function interruptActiveTurn() {
    // readline's SIGINT and the raw keypress listener both see one Ctrl+C.
    if (!isTurnActive || interruptRequested) return;
    interruptRequested = true;
    console.log(`\n  ${badge.warn} Interrupting active task...`);
    session.interrupt();
  }

  const onKeypress = (str, key) => {
    if (!isTurnActive) return;
    if ((key?.ctrl && key?.name === "c") || str === "\u0003") {
      interruptActiveTurn();
      return;
    }
    if (key?.name === "tab" || str === "\t") cycleStreamFocus();
  };
  process.stdin.on("keypress", onKeypress);

  const saveReplHistory = () => saveHistory((rl.history || []).filter((line) => !line.trim().startsWith("/")));

  /** `setRawMode(true)` is set for every turn; the shell must get its echo back. */
  function restoreTerminal() {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* stdin may already be closed */
      }
    }
  }

  async function quit(message) {
    console.log(`\n${badge.info} ${message}`);
    saveReplHistory();
    clearInterval(titleTimer);
    await session.stop().catch(() => {});
    restoreTerminal();
    process.exit(0);
  }

  process.on("exit", restoreTerminal);
  process.on("SIGTERM", () => {
    restoreTerminal();
    void session.stop().finally(() => process.exit(143));
  });

  /** Pause readline around a full-screen picker and restore it afterwards. */
  async function withPicker(fn) {
    const wasRaw = Boolean(process.stdin.isRaw);
    rl.pause();
    try {
      return await fn();
    } finally {
      process.stdin.resume();
      if (process.stdin.setRawMode) process.stdin.setRawMode(wasRaw);
      rl.line = "";
      rl.cursor = 0;
      rl.resume();
    }
  }

  const modelLine = () => {
    const s = session.settings;
    return `Orchestrator ${c.brightCyan}${s.orchestratorModel}-${s.reasoningEffort}${c.reset} [${s.orchestratorProvider}] • Worker ${c.brightBlue}${s.workerModel}-${s.workerEffort}${c.reset} [${s.workerProvider}]`;
  };

  /** Apply a settings change, saved as the default too, and redraw. */
  async function changeSettings(patch, message) {
    try {
      await session.updateSettings(patch, { persist: true });
      console.clear();
      header();
      console.log(`  ${badge.ok} ${message()}\n`);
      setKumoTitle(ws());
    } catch (err) {
      console.log(`  ${badge.warn} ${err.message}\n`);
    }
  }

  function printQuotas() {
    const quotas = session.quotas.snapshot();
    const s = session.settings;
    console.log(`\n  ${c.bold}Live Account Quotas & Remaining Limits:${c.reset}`);
    let any = false;
    for (const [role, title, model] of [["orchestrator", "Orchestrator", s.orchestratorModel], ["worker", "Worker", s.workerModel]]) {
      const lines = quotaLinesFor(role, s, quotas);
      if (lines.length === 0) continue;
      any = true;
      const plan = role === "orchestrator" && quotas.orchestrator?.planType ? ` [${quotas.orchestrator.planType}]` : "";
      console.log(`    ${c.bold}${title} (${model})${plan}:${c.reset}`);
      for (const line of lines) {
        console.log(`      ${`${line.label} Remaining:`.padEnd(19)}${progressBar(line.percent, 14)} ${c.gray}(resets ${line.reset})${c.reset}`);
      }
    }
    if (!any) console.log(`    ${c.dim}No quota figures available for these providers yet.${c.reset}`);
    console.log("");
  }

  async function handleCommand(input, line) {
    // Keep slash commands out of prompt history.
    if (rl.history && rl.history[0] === line) rl.history.shift();

    const parts = input.slice(1).split(" ").filter(Boolean);
    const cmd = (parts[0] || "").toLowerCase();
    const arg1 = parts[1];
    const arg2 = parts[2];
    const s = session.settings;

    switch (cmd) {
      case "help":
        console.log(`\n  ${c.bold}${c.brightCyan}KUMO — Cross-Provider AI Orchestrator${c.reset}`);
        console.log(separator(64));
        console.log(`  ${c.bold}Session & Workspaces:${c.reset}`);
        console.log(`    ${c.cyan}/new${c.reset}                     Start a fresh conversation thread`);
        console.log(`    ${c.cyan}/chats${c.reset}                   Browse and resume previous conversations`);
        console.log(`    ${c.cyan}/projects${c.reset}                Browse and switch registered workspaces`);
        console.log(`    ${c.cyan}/cd <path>${c.reset}               Switch active workspace directory`);
        console.log(`    ${c.cyan}/rename <title>${c.reset}          Rename current conversation`);
        console.log(`    ${c.cyan}/save [file]${c.reset}             Export conversation transcript to Markdown`);
        console.log("");
        console.log(`  ${c.bold}Models & Reasoning:${c.reset}`);
        console.log(`    ${c.cyan}/model${c.reset}                   Interactive arrow-key model & provider picker`);
        console.log(`    ${c.cyan}/model <name>${c.reset}            Quick-switch orchestrator model`);
        console.log(`    ${c.cyan}/model worker <name>${c.reset}     Quick-switch the shared worker model`);
        console.log(`    ${c.cyan}/role${c.reset}                    Show which model runs the lead and each role`);
        console.log(`    ${c.cyan}/role <role> <model>${c.reset}     Assign a model to a role ('default' clears it)`);
        console.log(`    ${c.cyan}/preset [name]${c.reset}           Apply or list configuration presets`);
        console.log(`    ${c.cyan}/effort <level>${c.reset}           Set orchestrator effort (${EFFORT_LEVELS.join(", ")})`);
        console.log(`    ${c.cyan}/effort worker <lvl>${c.reset}      Set worker effort`);
        console.log("");
        console.log(`  ${c.bold}Quotas & Utilities:${c.reset}`);
        console.log(`    ${c.cyan}/status${c.reset}, ${c.cyan}/quota${c.reset}            Show live rate limits and quota progress bars`);
        console.log(`    ${c.cyan}/refresh${c.reset}                  Re-fetch live quotas`);
        console.log(`    ${c.cyan}/clear${c.reset}, ${c.cyan}/cls${c.reset}             Clear console screen and re-render header`);
        console.log(`    ${c.cyan}/history${c.reset} [clean|clear]     View, clean settings from, or clear prompt history`);
        console.log(`    ${c.cyan}/exit${c.reset}, ${c.cyan}/quit${c.reset}              Quit interactive session cleanly`);
        console.log(separator(64) + "\n");
        return;

      case "history": {
        if (arg1 === "clear") {
          clearHistory();
          if (rl.history) rl.history.length = 0;
          console.log(`  ${badge.ok} Cleared all command and prompt history.\n`);
          return;
        }
        if (arg1 === "clean") {
          const remaining = cleanHistory();
          if (rl.history) rl.history = rl.history.filter((l) => !l.trim().startsWith("/"));
          console.log(`  ${badge.ok} Cleaned non-chat commands from history (${remaining.length} prompts kept).\n`);
          return;
        }
        const active = (rl.history || []).slice(0, 10);
        if (active.length === 0) {
          console.log(`  ${c.dim}No prompt history available.${c.reset}\n`);
        } else {
          console.log(`\n  ${c.bold}Recent Prompt History:${c.reset}`);
          active.forEach((item, idx) => console.log(`    ${c.gray}${String(idx + 1).padStart(2)}.${c.reset} ${item}`));
          console.log(`\n  ${c.dim}To clean non-chat commands:${c.reset} ${c.cyan}/history clean${c.reset}`);
          console.log(`  ${c.dim}To clear all history:${c.reset}       ${c.cyan}/history clear${c.reset}\n`);
        }
        return;
      }

      case "clear-history":
        clearHistory();
        if (rl.history) rl.history.length = 0;
        console.log(`  ${badge.ok} Cleared all command and prompt history.\n`);
        return;

      case "preset": {
        if (!arg1) {
          console.log(`\n  ${c.bold}Available Presets:${c.reset}`);
          for (const [key, p] of Object.entries(PRESETS)) {
            const active = presetMatches(key, s) ? ` ${c.brightGreen}[ACTIVE]${c.reset}` : "";
            console.log(`    ${c.cyan}${key.padEnd(14)}${c.reset}${p.description}${active}`);
          }
          console.log(`\n  ${c.dim}Usage:${c.reset} /preset <name>\n`);
          return;
        }
        if (!PRESETS[arg1]) {
          console.log(`  ${badge.warn} Unknown preset '${arg1}'. Available: ${Object.keys(PRESETS).join(", ")}\n`);
          return;
        }
        await changeSettings(presetConfig(arg1, s.roles), () => `Applied preset '${arg1}': ${modelLine()}`);
        return;
      }

      case "new":
        try {
          await session.newChat();
          console.clear();
          header();
          console.log(`  ${badge.ok} New conversation started.\n`);
        } catch (err) {
          console.log(`  ${badge.warn} ${err.message}\n`);
        }
        return;

      case "chats": {
        const chats = session.listChats();
        if (chats.length === 0) {
          console.log(`  ${c.dim}No saved chats for this project.${c.reset}\n`);
          return;
        }
        const chosen = await withPicker(() =>
          promptSelect({
            title: "Conversations",
            items: [
              ...chats.map((chat, i) => ({
                label: chat.title || `Chat ${i + 1}`,
                value: chat.id,
                hint: `${chat.turns || 0} turns • ${new Date(chat.lastUsedAt).toLocaleDateString()}`,
                isCurrent: chat.id === session.chatId,
              })),
              { label: "← Back to Session", value: "cancel" },
            ],
          })
        );
        if (!chosen || chosen === "cancel" || chosen === session.chatId) return;
        try {
          const { resumed } = await session.openChat(chosen);
          console.clear();
          header();
          const title = chats.find((x) => x.id === chosen)?.title || chosen;
          console.log(`  ${badge.ok} Switched to: ${title}`);
          console.log(
            resumed
              ? `  ${c.dim}The orchestrator resumed this conversation with its earlier turns.${c.reset}\n`
              : `  ${c.dim}New turns are saved to this chat, but the orchestrator starts a fresh conversation (this provider cannot resume it).${c.reset}\n`
          );
        } catch (err) {
          console.log(`  ${badge.warn} ${err.message}\n`);
        }
        return;
      }

      case "projects": {
        const projects = listProjects();
        if (projects.length === 0) {
          console.log(`  ${c.dim}No registered projects yet.${c.reset}\n`);
          return;
        }
        const chosen = await withPicker(() =>
          promptSelect({
            title: "Projects",
            items: [
              ...projects.map((p) => ({
                label: p.name || path.basename(p.path),
                value: p.path,
                hint: p.path,
                isCurrent: path.resolve(p.path) === path.resolve(ws()),
              })),
              { label: "← Back to Session", value: "cancel" },
            ],
          })
        );
        if (chosen && chosen !== "cancel" && path.resolve(chosen) !== path.resolve(ws())) await switchWorkspace(chosen);
        return;
      }

      case "cd":
      case "workspace":
      case "open":
        if (!arg1) {
          console.log(`  ${c.dim}Current workspace:${c.reset} ${ws()}`);
          console.log(`  ${c.dim}Usage:${c.reset} /cd <path>\n`);
          return;
        }
        await switchWorkspace(path.resolve(arg1));
        return;

      case "save":
        try {
          const out = session.exportMarkdown(arg1);
          console.log(`  ${badge.ok} Session saved to ${c.cyan}${out}${c.reset}\n`);
        } catch (err) {
          console.log(`  ${c.dim}${err.message}${c.reset}\n`);
        }
        return;

      case "rename": {
        const title = parts.slice(1).join(" ").trim();
        if (!title) {
          console.log(`  ${c.dim}Usage:${c.reset} /rename <new title>\n`);
          return;
        }
        session.renameChat(title);
        console.log(`  ${badge.ok} Chat renamed to "${title}"\n`);
        return;
      }

      case "model": {
        if (!arg1) {
          if (tty) {
            // The picker saves its choices to the config; the session follows.
            await withPicker(() => openInteractiveModelPicker({ onConfigChanged: async () => {} }));
            const saved = loadConfig();
            const patch = Object.fromEntries(SESSION_SETTING_KEYS.map((k) => [k, saved[k]]));
            try {
              const changed = await session.updateSettings(patch);
              if (changed.length > 0) {
                console.clear();
                header();
                console.log(`  ${badge.ok} Switched to ${modelLine()}\n`);
              }
            } catch (err) {
              console.log(`  ${badge.warn} ${err.message}\n`);
            }
            setKumoTitle(ws());
            return;
          }
          console.log(`\n  ${c.bold}Active Model Configuration:${c.reset}`);
          console.log(`    ${modelLine()}\n`);
          console.log(`  ${c.gray}To switch:${c.reset}`);
          console.log(`    ${c.cyan}/model <model-name>${c.reset}                  (switch orchestrator model)`);
          console.log(`    ${c.cyan}/model worker <model-name> [effort]${c.reset}  (switch worker model & effort)\n`);
          return;
        }
        if ((arg1 === "worker" || arg1 === "orchestrator") && !arg2) {
          console.log(`\n  ${modelLine()}`);
          console.log(`\n  ${c.gray}Usage:${c.reset} /model <model> | /model worker <model> [effort]\n`);
          return;
        }
        if (arg1 === "worker") {
          const model = resolveModel(arg2);
          const patch = { workerModel: model, workerProvider: providerForModel(model, s.workerProvider) };
          if (parts[3]) patch.workerEffort = parts[3].toLowerCase();
          await changeSettings(patch, () => `Worker switched to ${c.brightBlue}${model}-${session.settings.workerEffort}${c.reset} [${session.settings.workerProvider}]`);
          return;
        }
        const target = arg1 === "orchestrator" ? arg2 : arg1;
        if (PRESETS[target]) {
          await changeSettings(presetConfig(target, s.roles), () => `Applied preset '${target}': ${modelLine()}`);
          return;
        }
        const model = resolveModel(target);
        await changeSettings(
          { orchestratorModel: model, orchestratorProvider: providerForModel(model, s.orchestratorProvider) },
          () => `Orchestrator switched to ${c.brightCyan}${model}-${session.settings.reasoningEffort}${c.reset} [${session.settings.orchestratorProvider}]`
        );
        return;
      }

      case "role":
      case "roles": {
        if (!arg1) {
          console.log(`\n  ${c.bold}Roles${c.reset} ${c.dim}(this session)${c.reset}`);
          for (const roleLine of formatRoles(s)) console.log(roleLine);
          console.log(`\n  ${c.dim}Usage:${c.reset} /role <role> <model> [effort] [provider] ${c.dim}('default' puts a role back on the shared worker)${c.reset}\n`);
          return;
        }
        if (!arg2) {
          console.log(`  ${c.dim}Usage:${c.reset} /role <role> <model> [effort] [provider]\n`);
          return;
        }
        let patch;
        try {
          patch = roleSetPatch(s, arg1, arg2, parts[3], parts[4]);
        } catch (err) {
          console.log(`  ${badge.warn} ${err.message}\n`);
          return;
        }
        const name = arg1.toLowerCase();
        await changeSettings(patch, () => {
          const now = session.settings;
          if (name === "lead" || name === "orchestrator") {
            const lead = { provider: now.orchestratorProvider, model: now.orchestratorModel, effort: now.reasoningEffort };
            return `The lead runs on ${c.brightCyan}${describeTarget(lead)}${c.reset}`;
          }
          const own = roleAssignment(now, name);
          return own
            ? `${name} runs on ${c.brightBlue}${describeTarget({ ...own, effort: own.effort || now.workerEffort })}${c.reset}`
            : `${name} runs on the shared worker (${c.brightBlue}${now.workerModel}-${now.workerEffort}${c.reset})`;
        });
        return;
      }

      case "effort":
      case "reasoning": {
        const worker = arg1 === "worker";
        const level = (worker ? arg2 : arg1)?.toLowerCase();
        if (!level) {
          console.log(`\n  ${c.dim}Orchestrator reasoning effort:${c.reset} ${c.brightCyan}${s.reasoningEffort}${c.reset}`);
          console.log(`  ${c.dim}Worker reasoning effort:${c.reset}       ${c.brightBlue}${s.workerEffort}${c.reset}`);
          console.log(`  ${c.dim}Usage:${c.reset} /effort [worker] <${EFFORT_LEVELS.join("|")}>\n`);
          return;
        }
        if (!EFFORT_LEVELS.includes(level)) {
          console.log(`\n${badge.warn} Invalid effort '${level}'. Supported: ${EFFORT_LEVELS.join(", ")}\n`);
          return;
        }
        await changeSettings(worker ? { workerEffort: level } : { reasoningEffort: level }, () =>
          worker
            ? `Worker reasoning effort set to ${c.brightBlue}${level}${c.reset}`
            : `Orchestrator reasoning effort set to ${c.brightCyan}${level}${c.reset}`
        );
        return;
      }

      case "clear":
      case "cls":
        console.clear();
        header();
        return;

      case "status":
      case "limits":
      case "quota":
      case "usage":
        await session.refreshQuotas().catch(() => {});
        printQuotas();
        return;

      case "refresh": {
        const quotas = await session.refreshQuotas().catch(() => session.quotas.snapshot());
        const orch = quotas.orchestrator?.remainingPercent;
        console.log(
          `  ${badge.ok} Quotas refreshed: ${s.orchestratorModel} ${orch ?? "?"}% remaining` +
            (quotas.antigravity ? ` • Antigravity figures updated` : "") +
            "\n"
        );
        return;
      }

      case "exit":
      case "quit":
      case "q":
        await quit("Exiting Kumo session.");
        return;

      default:
        console.log(`  ${badge.warn} Unknown command '/${cmd}'. Type ${c.cyan}/help${c.reset} for available commands.`);
    }
  }

  async function switchWorkspace(target) {
    try {
      await session.setWorkspace(target);
      console.clear();
      header();
      console.log(`  ${badge.ok} Switched to workspace: ${ws()}\n`);
      setKumoTitle(ws());
    } catch (err) {
      console.log(`  ${badge.warn} ${err.message}\n`);
    }
  }

  async function runPrompt(input) {
    isTurnActive = true;
    interruptRequested = false;
    rl.pause();
    const turnWasRaw = Boolean(process.stdin.isRaw);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    process.stdout.write("\n");
    titleTimer = setInterval(updateWorkerTitle, 1000);
    titleTimer.unref();

    let outcome;
    try {
      outcome = await session.send(input);
    } catch (err) {
      outcome = { ok: false, reason: err.message, elapsedMs: 0 };
    } finally {
      clearInterval(titleTimer);
      titleTimer = null;
      activeTools.clear();
      streamBuffers.clear();
      focusedStream = "orchestrator";
      spinner.stop();
      setKumoTitle(ws());
      isTurnActive = false;
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(turnWasRaw);
    }

    const elapsed = ((outcome.elapsedMs || 0) / 1000).toFixed(1);
    if (outcome.ok) {
      console.log(`\n  ${c.dim}✓ Completed in ${elapsed}s${c.reset}\n`);
    } else {
      console.error(`\n  ${badge.fail} ${outcome.reason}`);
      // A failed turn is not recorded: it would corrupt /save transcripts.
      console.log(`\n  ${badge.fail} Turn ended without completion after ${elapsed}s\n`);
    }
    saveReplHistory();
    rl.resume();
  }

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (isTurnActive) return;
    if (!input) {
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      await handleCommand(input, line);
    } else {
      await runPrompt(input);
    }
    rl.prompt();
  });

  let sigintCount = 0;
  rl.on("SIGINT", async () => {
    if (isTurnActive) {
      interruptActiveTurn();
      return;
    }
    sigintCount++;
    if (sigintCount === 1) {
      console.log(`\n  ${c.dim}Press Ctrl+C again or type /exit to quit.${c.reset}`);
      rl.prompt();
      setTimeout(() => (sigintCount = 0), 2000);
    } else {
      await quit("Goodbye.");
    }
  });

  rl.on("close", async () => {
    process.stdin.removeListener("keypress", onKeypress);
    saveReplHistory();
    clearInterval(titleTimer);
    await session.stop().catch(() => {});
    restoreTerminal();
    process.exit(0);
  });
}
