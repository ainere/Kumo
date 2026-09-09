/**
 * model-picker.js — Interactive terminal selector with keyboard arrow-key navigation.
 * Allows users to browse and switch presets, orchestrator models (Codex), worker models (Antigravity),
 * and reasoning efforts using ↑ / ↓ arrows, Enter, and Esc.
 */

import readline from "node:readline";
import { c, badge, separator } from "./ui.js";
import { loadConfig, setConfigValue, applyPreset, PRESETS } from "../config/settings.js";
import { getAgyModels } from "../../bridge/agy-runner.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";

/** Default known orchestrator models (Codex) */
export const DEFAULT_CODEX_MODELS = [
  { id: "chatgpt-6-astra", name: "ChatGPT 6 Astra", desc: "Frontier reasoning model for planning & review (ChatGPT Plus)" },
  { id: "chatgpt-5.6-sol", name: "ChatGPT 5.6 Sol", desc: "High-speed reasoning orchestrator" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", desc: "Balanced agentic coding model for everyday work" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", desc: "Fast and affordable agentic coding model" },
  { id: "gpt-5.5", name: "GPT-5.5", desc: "Proven previous-generation model (low quota safe)" },
];

/** Concise summaries for built-in presets */
export const PRESET_SUMMARIES = {
  default: "Astra Low + Gemini 3.8 Medium",
  pro: "Astra Medium + Gemini 3.8 High",
  speed: "Sol Low + Gemini 3.8 Low",
  "gemini-3.7": "Astra Low + Gemini 3.7 Medium",
  test: "GPT-5.5 Low + Gemini 3.6 Low",
};

/** Strip ANSI color sequences for accurate visible length calculation */
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Truncate a styled string to maximum visible column width without breaking escape codes */
function truncateToWidth(str, maxWidth) {
  const plain = stripAnsi(str);
  if (plain.length <= maxWidth) return str;

  let visible = 0;
  let res = "";
  let inEscape = false;

  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\x1b") inEscape = true;
    if (!inEscape) {
      visible++;
      if (visible >= maxWidth - 1) {
        res += `…${c.reset}`;
        break;
      }
    }
    res += str[i];
    if (inEscape && (str[i] === "m" || str[i] === "K" || str[i] === "J")) inEscape = false;
  }
  return res;
}

/**
 * Fetch available orchestrator models dynamically from Codex app-server,
 * with graceful fallback to built-in models.
 */
export async function getOrchestratorModels() {
  try {
    const client = new CodexAppClient();
    await client.start();
    const res = await client.request("model/list").catch(() => null);
    await client.stop().catch(() => {});

    if (res && Array.isArray(res.data) && res.data.length > 0) {
      const models = [];
      const seen = new Set();

      // Ensure frontier Astra & Sol are at the top
      for (const m of DEFAULT_CODEX_MODELS.slice(0, 2)) {
        seen.add(m.id);
        models.push(m);
      }

      for (const item of res.data) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          models.push({
            id: item.id,
            name: item.displayName || item.id,
            desc: item.description || "",
          });
        }
      }
      return models;
    }
  } catch {
    /* fallback to defaults */
  }
  return DEFAULT_CODEX_MODELS;
}

/**
 * Interactive list selector using terminal arrow keys.
 * Controlled directly via stdin raw mode without creating sub-readline interfaces,
 * ensuring the outer REPL maintains working keyboard input.
 *
 * @param {Object} opts
 * @param {string} opts.title — Header title for menu
 * @param {Array<{label: string, value: any, hint?: string, isCurrent?: boolean}>} opts.items — Selectable items
 * @param {number} [opts.initialIndex=0]
 * @returns {Promise<any | null>} Selected item value or null if cancelled
 */
export async function promptSelect({ title, items, initialIndex = 0 }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Non-interactive fallback: print items
    console.log(`\n  ${c.bold}${title}${c.reset}`);
    for (const item of items) {
      const marker = item.isCurrent ? " *" : "  ";
      console.log(`${marker} ${item.label.padEnd(20)} ${item.hint || ""}`);
    }
    return null;
  }

  return new Promise((resolve) => {
    let selectedIndex = Math.max(0, Math.min(items.length - 1, initialIndex));
    let renderedLines = 0;

    // Enable keypress events on stdin directly
    readline.emitKeypressEvents(process.stdin);

    const wasRaw = Boolean(process.stdin.isRaw);
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Hide cursor during navigation
    process.stdout.write("\x1b[?25l");

    function render(first = false) {
      if (!first && renderedLines > 0) {
        readline.cursorTo(process.stdout, 0);
        const moveUp = renderedLines > 1 ? renderedLines - 1 : 0;
        readline.moveCursor(process.stdout, 0, -moveUp);
        readline.clearScreenDown(process.stdout);
      }

      const cols = process.stdout.columns || 80;
      const maxLen = Math.max(40, cols - 4);
      const out = [];

      out.push(truncateToWidth(`  ${c.bold}${c.brightCyan}${title}${c.reset}`, maxLen));
      out.push(truncateToWidth(`  ${c.gray}Use ${c.brightCyan}↑ / ↓${c.gray} to navigate, ${c.brightCyan}Enter${c.gray} to select, ${c.brightCyan}Esc${c.gray} to cancel.${c.reset}`, maxLen));
      out.push("");

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isSel = i === selectedIndex;
        const currentTag = item.isCurrent ? ` ${c.brightGreen}[ACTIVE]${c.reset}` : "";
        const hintTag = item.hint ? ` ${c.skyBlue}(${item.hint})${c.reset}` : "";

        let line = "";
        if (isSel) {
          line = `  ${c.brightCyan}❯${c.reset} ${c.bold}${c.brightWhite}${item.label}${c.reset}${hintTag}${currentTag}`;
        } else {
          line = `    ${c.gray}${item.label}${c.reset}${hintTag}${currentTag}`;
        }
        out.push(truncateToWidth(line, maxLen));
      }

      renderedLines = out.length;
      process.stdout.write(out.join("\n"));
    }

    function cleanup(clearRendered = true) {
      process.stdin.removeListener("keypress", onKeypress);
      if (clearRendered && renderedLines > 0) {
        readline.cursorTo(process.stdout, 0);
        const moveUp = renderedLines > 1 ? renderedLines - 1 : 0;
        readline.moveCursor(process.stdout, 0, -moveUp);
        readline.clearScreenDown(process.stdout);
      }
      process.stdout.write("\x1b[?25h"); // Show cursor
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(wasRaw);
      }
      process.stdin.resume();
    }

    function onKeypress(str, key) {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        cleanup(true);
        console.log(`  ${badge.info} Cancelled.\n`);
        return resolve(null);
      }

      if (key.name === "escape" || str === "q") {
        cleanup(true);
        console.log(`  ${badge.info} Cancelled.\n`);
        return resolve(null);
      }

      if (key.name === "up" || key.name === "k") {
        const nextIndex = selectedIndex > 0 ? selectedIndex - 1 : items.length - 1;
        if (nextIndex !== selectedIndex) {
          selectedIndex = nextIndex;
          render();
        }
        return;
      }

      if (key.name === "down" || key.name === "j") {
        const nextIndex = selectedIndex < items.length - 1 ? selectedIndex + 1 : 0;
        if (nextIndex !== selectedIndex) {
          selectedIndex = nextIndex;
          render();
        }
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        cleanup(true);
        return resolve(items[selectedIndex].value);
      }
    }

    process.stdin.on("keypress", onKeypress);
    render(true);
  });
}

/**
 * Full interactive model manager dialog.
 * Guides the user through presets, orchestrator models, worker models, and reasoning efforts.
 *
 * @param {Object} [opts]
 * @param {Function} [opts.onConfigChanged] — Optional callback after configuration updates
 * @returns {Promise<Object>} Updated config
 */
export async function openInteractiveModelPicker(opts = {}) {
  const config = loadConfig();

  const mainChoices = [
    {
      label: "Apply Preset Profile",
      value: "preset",
      hint: "default, pro, speed, test",
    },
    {
      label: "Select Orchestrator Model",
      value: "orchestrator",
      hint: `${config.orchestratorModel}-${config.reasoningEffort}`,
    },
    {
      label: "Select Worker Model",
      value: "worker",
      hint: `${config.workerModel}-${config.workerEffort || 'medium'}`,
    },
    {
      label: "Set Reasoning Effort",
      value: "effort",
      hint: `Orchestrator: ${config.reasoningEffort} • Worker: ${config.workerEffort || 'medium'}`,
    },
    {
      label: "Cancel",
      value: "cancel",
      hint: "Return to session",
    },
  ];

  const action = await promptSelect({
    title: "KUMO Model Configuration",
    items: mainChoices,
  });

  if (!action || action === "cancel") {
    if (action === "cancel") {
      console.log(`  ${badge.info} Cancelled.\n`);
    }
    return config;
  }

  // 1. Preset Picker
  if (action === "preset") {
    const presetItems = Object.entries(PRESETS).map(([key, p]) => {
      const isCurrent =
        config.orchestratorModel === p.config.orchestratorModel &&
        config.workerModel === p.config.workerModel &&
        config.reasoningEffort === p.config.reasoningEffort &&
        (config.workerEffort || "medium") === (p.config.workerEffort || "medium");
      return {
        label: p.name,
        value: key,
        hint: key,
        isCurrent,
      };
    });
    presetItems.push({
      label: "Cancel",
      value: "cancel",
      hint: "Return to session",
    });

    const chosenPreset = await promptSelect({
      title: "Select Configuration Preset",
      items: presetItems,
    });

    if (chosenPreset && chosenPreset !== "cancel") {
      applyPreset(chosenPreset);
      const updated = loadConfig();
      console.log(`  ${badge.ok} Applied preset ${c.bold}${chosenPreset}${c.reset}:`);
      console.log(`    ${c.gray}• Orchestrator:${c.reset} ${c.brightCyan}${updated.orchestratorModel}-${updated.reasoningEffort}${c.reset}`);
      console.log(`    ${c.gray}• Worker:${c.reset}       ${c.brightBlue}${updated.workerModel}-${updated.workerEffort || 'medium'}${c.reset}\n`);
      if (opts.onConfigChanged) await opts.onConfigChanged(updated);
      return updated;
    }
    if (chosenPreset === "cancel") {
      console.log(`  ${badge.info} Cancelled.\n`);
    }
    return config;
  }

  // 2. Orchestrator Model Picker
  if (action === "orchestrator") {
    console.log(`  ${c.gray}Fetching available orchestrator models from Codex...${c.reset}`);
    const models = await getOrchestratorModels();

    const modelItems = models.map((m) => ({
      label: m.name || m.id,
      value: m.id,
      hint: m.id,
      isCurrent: config.orchestratorModel === m.id,
    }));
    modelItems.push({
      label: "Cancel",
      value: "cancel",
      hint: "Return to session",
    });

    const chosenModel = await promptSelect({
      title: "Select Orchestrator Model (Codex)",
      items: modelItems,
    });

    if (chosenModel && chosenModel !== "cancel") {
      setConfigValue("orchestratorModel", chosenModel);
      const updated = loadConfig();
      console.log(`  ${badge.ok} Orchestrator model set to ${c.brightCyan}${chosenModel}-${updated.reasoningEffort}${c.reset}\n`);
      if (opts.onConfigChanged) await opts.onConfigChanged(updated);
      return updated;
    }
    if (chosenModel === "cancel") {
      console.log(`  ${badge.info} Cancelled.\n`);
    }
    return config;
  }

  // 3. Worker Model Picker
  if (action === "worker") {
    console.log(`  ${c.gray}Fetching available worker models from Antigravity...${c.reset}`);
    const models = await getAgyModels();

    const modelItems = models.map((m) => ({
      label: m.name || m.id,
      value: m.id,
      hint: m.id,
      isCurrent: config.workerModel === m.id,
    }));
    modelItems.push({
      label: "Cancel",
      value: "cancel",
      hint: "Return to session",
    });

    const chosenWorker = await promptSelect({
      title: "Select Worker Model (Antigravity)",
      items: modelItems,
    });

    if (chosenWorker && chosenWorker !== "cancel") {
      setConfigValue("workerModel", chosenWorker);
      const updated = loadConfig();
      console.log(`  ${badge.ok} Worker model set to ${c.brightBlue}${chosenWorker}-${updated.workerEffort || 'medium'}${c.reset}\n`);
      if (opts.onConfigChanged) await opts.onConfigChanged(updated);
      return updated;
    }
    if (chosenWorker === "cancel") {
      console.log(`  ${badge.info} Cancelled.\n`);
    }
    return config;
  }

  // 4. Reasoning Effort
  if (action === "effort") {
    const effortTargets = [
      {
        label: "Orchestrator Reasoning Effort",
        value: "orch",
        hint: `Active: ${config.reasoningEffort}`,
      },
      {
        label: "Worker Reasoning Effort",
        value: "work",
        hint: `Active: ${config.workerEffort || 'medium'}`,
      },
      {
        label: "Cancel",
        value: "cancel",
        hint: "Return to session",
      },
    ];

    const target = await promptSelect({
      title: "Select Reasoning Effort Target",
      items: effortTargets,
    });

    if (!target || target === "cancel") {
      if (target === "cancel") {
        console.log(`  ${badge.info} Cancelled.\n`);
      }
      return config;
    }

    if (target === "orch") {
      const orchHints = {
        low: "Fast & quota-efficient",
        medium: "Balanced everyday reasoning",
        high: "Deep thinking & architecture",
        max: "Maximum reasoning depth",
      };
      const levels = ["low", "medium", "high", "max"].map((lvl) => ({
        label: lvl.toUpperCase(),
        value: lvl,
        hint: orchHints[lvl] || "Reasoning depth",
        isCurrent: config.reasoningEffort === lvl,
      }));
      levels.push({
        label: "Cancel",
        value: "cancel",
        hint: "Return to session",
      });

      const chosen = await promptSelect({
        title: "Select Orchestrator Reasoning Effort",
        items: levels,
      });

      if (chosen && chosen !== "cancel") {
        setConfigValue("reasoningEffort", chosen);
        const updated = loadConfig();
        console.log(`  ${badge.ok} Orchestrator reasoning effort set to ${c.brightCyan}${chosen}${c.reset}\n`);
        if (opts.onConfigChanged) await opts.onConfigChanged(updated);
        return updated;
      }
      if (chosen === "cancel") {
        console.log(`  ${badge.info} Cancelled.\n`);
      }
      return config;
    } else if (target === "work") {
      const workerHints = {
        low: "Fastest execution & lowest latency",
        medium: "Standard balanced execution",
        high: "Thorough multi-step thinking",
      };
      const levels = ["low", "medium", "high"].map((lvl) => ({
        label: lvl.toUpperCase(),
        value: lvl,
        hint: workerHints[lvl] || "Reasoning depth",
        isCurrent: (config.workerEffort || "medium") === lvl,
      }));
      levels.push({
        label: "Cancel",
        value: "cancel",
        hint: "Return to session",
      });

      const chosen = await promptSelect({
        title: "Select Worker Reasoning Effort",
        items: levels,
      });

      if (chosen && chosen !== "cancel") {
        setConfigValue("workerEffort", chosen);
        const updated = loadConfig();
        console.log(`  ${badge.ok} Worker reasoning effort set to ${c.brightBlue}${chosen}${c.reset}\n`);
        if (opts.onConfigChanged) await opts.onConfigChanged(updated);
        return updated;
      }
      if (chosen === "cancel") {
        console.log(`  ${badge.info} Cancelled.\n`);
      }
      return config;
    }
  }

  return config;
}
