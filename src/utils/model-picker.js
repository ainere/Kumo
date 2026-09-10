/**
 * model-picker.js — Interactive terminal selector with keyboard arrow-key navigation.
 * Allows users to browse and switch presets, orchestrator models (Codex), worker models (Antigravity),
 * and reasoning efforts using ↑ / ↓ arrows, Enter, and Esc.
 */

import readline from "node:readline";
import { c, badge, separator } from "./ui.js";
import { loadConfig, setConfigValue, applyPreset, PRESETS } from "../config/settings.js";
import { getAgyModels } from "../bridge/agy-runner.js";
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

let _keypressInitialized = false;

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
    let cleanedUp = false;

    // Guard existing keypress listeners (e.g. from an outer readline Interface)
    // so keystrokes in the menu don't leak into readline or trigger spurious line events
    const savedKeypressListeners = process.stdin.rawListeners("keypress");
    process.stdin.removeAllListeners("keypress");

    // Enable keypress events on stdin directly (guarded against stacking)
    if (!_keypressInitialized) {
      readline.emitKeypressEvents(process.stdin);
      _keypressInitialized = true;
    }

    const wasRaw = Boolean(process.stdin.isRaw);
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }

    // Hide cursor during navigation
    process.stdout.write("\x1b[?25l");

    function render(first = false) {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;
      const maxLen = Math.max(30, cols - 2);

      // Max items to show at once to prevent terminal scrolling overflow
      const maxVisible = Math.max(5, rows - 5);
      let startIndex = 0;
      if (items.length > maxVisible) {
        const half = Math.floor(maxVisible / 2);
        startIndex = Math.max(0, Math.min(items.length - maxVisible, selectedIndex - half));
      }
      const visibleItems = items.slice(startIndex, startIndex + maxVisible);

      const lines = [];
      lines.push(truncateToWidth(`  ${c.bold}${c.brightCyan}${title}${c.reset}`, maxLen));

      if (startIndex > 0) {
        lines.push(truncateToWidth(`  ${c.dim}▲ ${startIndex} more above${c.reset}`, maxLen));
      }

      for (let i = 0; i < visibleItems.length; i++) {
        const item = visibleItems[i];
        const actualIndex = startIndex + i;
        const isSelected = actualIndex === selectedIndex;
        const prefix = isSelected ? `  ${c.brightCyan}❯${c.reset} ` : "    ";
        const labelColor = isSelected ? `${c.bold}${c.brightWhite}` : c.gray;
        const activeMarker = item.isCurrent ? ` ${c.brightGreen}[ACTIVE]${c.reset}` : "";
        const hintText = item.hint ? `  ${c.dim}(${item.hint})${c.reset}` : "";

        lines.push(truncateToWidth(`${prefix}${labelColor}${item.label}${c.reset}${activeMarker}${hintText}`, maxLen));
      }

      if (startIndex + maxVisible < items.length) {
        const remaining = items.length - (startIndex + maxVisible);
        lines.push(truncateToWidth(`  ${c.dim}▼ ${remaining} more below${c.reset}`, maxLen));
      }

      lines.push(truncateToWidth(`  ${c.dim}↑/↓ navigate • Enter select • Esc cancel${c.reset}`, maxLen));

      // Build single atomic escape sequence buffer for flicker-free, non-scrolling redraw
      let buf = "";
      if (!first && renderedLines > 0) {
        const moveUp = renderedLines > 1 ? renderedLines - 1 : 0;
        buf += "\x1b[1G";
        if (moveUp > 0) {
          buf += `\x1b[${moveUp}A`;
        }
        buf += "\x1b[0J";
      }

      buf += lines.join("\n");
      process.stdout.write(buf);
      renderedLines = lines.length;
    }

    function cleanup(clearRendered = true) {
      if (cleanedUp) return;
      cleanedUp = true;

      process.stdin.removeListener("keypress", onKeypress);
      process.stdout.removeListener("resize", onResize);

      // Restore outer keypress listeners so REPL resumes receiving keyboard events
      for (const listener of savedKeypressListeners) {
        process.stdin.on("keypress", listener);
      }

      if (clearRendered && renderedLines > 0) {
        const moveUp = renderedLines > 1 ? renderedLines - 1 : 0;
        let buf = "\x1b[1G";
        if (moveUp > 0) {
          buf += `\x1b[${moveUp}A`;
        }
        buf += "\x1b[0J\x1b[?25h";
        process.stdout.write(buf);
      } else {
        process.stdout.write("\x1b[?25h");
      }

      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(wasRaw);
      }
      process.stdin.resume();
    }

    const onResize = () => {
      render();
    };
    process.stdout.on("resize", onResize);

    function onKeypress(str, key) {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        cleanup(true);
        console.log(`  ${badge.info} Cancelled.\n`);
        return resolve(null);
      }

      if (key.name === "escape" || str === "q") {
        cleanup(true);
        return resolve(null);
      }

      if (key.name === "left") {
        cleanup(true);
        return resolve(null);
      }

      if (key.name === "home") {
        if (selectedIndex !== 0) {
          selectedIndex = 0;
          render();
        }
        return;
      }

      if (key.name === "end") {
        if (selectedIndex !== items.length - 1) {
          selectedIndex = items.length - 1;
          render();
        }
        return;
      }

      if (key.name === "pageup") {
        const nextIndex = Math.max(0, selectedIndex - 5);
        if (nextIndex !== selectedIndex) {
          selectedIndex = nextIndex;
          render();
        }
        return;
      }

      if (key.name === "pagedown") {
        const nextIndex = Math.min(items.length - 1, selectedIndex + 5);
        if (nextIndex !== selectedIndex) {
          selectedIndex = nextIndex;
          render();
        }
        return;
      }

      if (str >= "1" && str <= "9") {
        const idx = parseInt(str, 10) - 1;
        if (idx < items.length) {
          cleanup(true);
          return resolve(items[idx].value);
        }
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
    process.stdin.resume();
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
  let config = loadConfig();
  let mainIndex = 0;

  while (true) {
    const mainChoices = [
      {
        label: "Apply Preset",
        value: "preset",
        hint: "Switch both models and effort levels at once",
      },
      {
        label: "Orchestrator Model",
        value: "orchestrator",
        hint: `${config.orchestratorModel} • ${config.reasoningEffort} effort`,
      },
      {
        label: "Worker Model",
        value: "worker",
        hint: `${config.workerModel} • ${config.workerEffort || "medium"} effort`,
      },
      {
        label: "Reasoning Effort",
        value: "effort",
        hint: `Orchestrator: ${config.reasoningEffort} • Worker: ${config.workerEffort || "medium"}`,
      },
      {
        label: "← Back to Session",
        value: "cancel",
      },
    ];

    const action = await promptSelect({
      title: "KUMO Model Configuration",
      items: mainChoices,
      initialIndex: mainIndex,
    });

    if (!action || action === "cancel") {
      return config;
    }

    // 1. Preset Picker
    if (action === "preset") {
      mainIndex = 0;
      const presetItems = Object.entries(PRESETS).map(([key, p]) => {
        const isCurrent =
          config.orchestratorModel === p.config.orchestratorModel &&
          config.workerModel === p.config.workerModel &&
          config.reasoningEffort === p.config.reasoningEffort &&
          (config.workerEffort || "medium") === (p.config.workerEffort || "medium");
        return {
          label: p.name,
          value: key,
          hint: p.description,
          isCurrent,
        };
      });
      presetItems.push({
        label: "← Back",
        value: "cancel",
        hint: "Return to main menu",
      });

      const chosenPreset = await promptSelect({
        title: "Select Configuration Preset",
        items: presetItems,
      });

      if (!chosenPreset || chosenPreset === "cancel") {
        continue;
      }

      applyPreset(chosenPreset);
      const updated = loadConfig();
      console.log(`  ${badge.ok} Applied preset ${c.bold}${chosenPreset}${c.reset}:`);
      console.log(`    ${c.gray}• Orchestrator:${c.reset} ${c.brightCyan}${updated.orchestratorModel}-${updated.reasoningEffort}${c.reset}`);
      console.log(`    ${c.gray}• Worker:${c.reset}       ${c.brightBlue}${updated.workerModel}-${updated.workerEffort || 'medium'}${c.reset}\n`);
      if (opts.onConfigChanged) await opts.onConfigChanged(updated);
      return updated;
    }

    // 2. Orchestrator Model Picker (Provider-First)
    if (action === "orchestrator") {
      mainIndex = 1;
      const providerItems = [
        {
          label: "Codex (OpenAI)",
          value: "codex",
          hint: "ChatGPT 6 Astra, Sol, Terra, Luna, GPT-5.5",
          isCurrent: config.orchestratorProvider === "codex",
        },
        {
          label: "Antigravity (Google / Anthropic)",
          value: "antigravity",
          hint: "Gemini 3.8, 3.7, Claude Opus, Claude Sonnet, GPT-OSS",
          isCurrent: config.orchestratorProvider !== "codex",
        },
        { label: "← Back", value: "cancel", hint: "Return to main menu" },
      ];

      const provider = await promptSelect({
        title: "Select Orchestrator Provider",
        items: providerItems,
      });

      if (!provider || provider === "cancel") continue;

      const models = provider === "codex" ? await getOrchestratorModels() : await getAgyModels();

      const modelItems = models.map((m) => ({
        label: m.name || m.id,
        value: m.id,
        hint: m.desc || m.id,
        isCurrent: config.orchestratorModel === m.id,
      }));
      modelItems.push({
        label: "← Back",
        value: "cancel",
        hint: "Return to main menu",
      });

      const chosenModel = await promptSelect({
        title: "Select Orchestrator Model",
        items: modelItems,
      });

      if (!chosenModel || chosenModel === "cancel") {
        continue;
      }

      setConfigValue("orchestratorProvider", provider);
      setConfigValue("orchestratorModel", chosenModel);
      const updated = loadConfig();
      console.log(`  ${badge.ok} Orchestrator model set to ${c.brightCyan}${chosenModel}-${updated.reasoningEffort}${c.reset}\n`);
      if (opts.onConfigChanged) await opts.onConfigChanged(updated);
      return updated;
    }

    // 3. Worker Model Picker (Provider-First)
    if (action === "worker") {
      mainIndex = 2;
      const providerItems = [
        {
          label: "Antigravity (Google / Anthropic)",
          value: "antigravity",
          hint: "Gemini 3.8, 3.7, Claude Opus, Claude Sonnet, GPT-OSS",
          isCurrent: config.workerProvider !== "codex",
        },
        {
          label: "Codex (OpenAI)",
          value: "codex",
          hint: "ChatGPT 6 Astra, Sol, Terra, Luna, GPT-5.5",
          isCurrent: config.workerProvider === "codex",
        },
        { label: "← Back", value: "cancel", hint: "Return to main menu" },
      ];

      const provider = await promptSelect({
        title: "Select Worker Provider",
        items: providerItems,
      });

      if (!provider || provider === "cancel") continue;

      const models = provider === "codex" ? await getOrchestratorModels() : await getAgyModels();

      const modelItems = models.map((m) => ({
        label: m.name || m.id,
        value: m.id,
        hint: m.desc || m.id,
        isCurrent: config.workerModel === m.id,
      }));
      modelItems.push({
        label: "← Back",
        value: "cancel",
        hint: "Return to main menu",
      });

      const chosenWorker = await promptSelect({
        title: "Select Worker Model",
        items: modelItems,
      });

      if (!chosenWorker || chosenWorker === "cancel") {
        continue;
      }

      setConfigValue("workerProvider", provider === "antigravity" ? "gemini" : provider);
      setConfigValue("workerModel", chosenWorker);
      const updated = loadConfig();
      console.log(`  ${badge.ok} Worker model set to ${c.brightBlue}${chosenWorker}-${updated.workerEffort || 'medium'}${c.reset}\n`);
      if (opts.onConfigChanged) await opts.onConfigChanged(updated);
      return updated;
    }

    // 4. Reasoning Effort
    if (action === "effort") {
      mainIndex = 3;
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
          label: "← Back",
          value: "cancel",
          hint: "Return to main menu",
        },
      ];

      const target = await promptSelect({
        title: "Reasoning Effort",
        items: effortTargets,
      });

      if (!target || target === "cancel") {
        continue;
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
          label: "← Back",
          value: "cancel",
          hint: "Return to main menu",
        });

        const chosen = await promptSelect({
          title: "Orchestrator Effort",
          items: levels,
        });

        if (!chosen || chosen === "cancel") {
          continue;
        }

        setConfigValue("reasoningEffort", chosen);
        const updated = loadConfig();
        console.log(`  ${badge.ok} Orchestrator reasoning effort set to ${c.brightCyan}${chosen}${c.reset}\n`);
        if (opts.onConfigChanged) await opts.onConfigChanged(updated);
        return updated;
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
          label: "← Back",
          value: "cancel",
          hint: "Return to main menu",
        });

        const chosen = await promptSelect({
          title: "Worker Effort",
          items: levels,
        });

        if (!chosen || chosen === "cancel") {
          continue;
        }

        setConfigValue("workerEffort", chosen);
        const updated = loadConfig();
        console.log(`  ${badge.ok} Worker reasoning effort set to ${c.brightBlue}${chosen}${c.reset}\n`);
        if (opts.onConfigChanged) await opts.onConfigChanged(updated);
        return updated;
      }
    }
  }

  return config;
}
