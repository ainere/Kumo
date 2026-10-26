/**
 * model-picker.js — Interactive terminal selector with keyboard arrow-key navigation.
 * Allows users to browse and switch presets, orchestrator models (Codex), worker models (Antigravity),
 * and reasoning efforts using ↑ / ↓ arrows, Enter, and Esc.
 */

import readline from "node:readline";
import { c, badge } from "./ui.js";
import {
  loadConfig,
  setConfigValue,
  applyPreset,
  presetMatches,
  PRESETS,
} from "../config/settings.js";
import { getAgyModels } from "../bridge/agy-runner.js";
import { MODEL_CATALOG, allKnownModels, providerOffersModel, OPEN_MODEL_PROVIDERS, EFFORT_LEVELS } from "../config/models.js";
import { safeSpawn } from "./process.js";
import { findOllamaBinary } from "../providers/workers/ollama.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";

/** Default known orchestrator models (Codex), used when the server cannot list its own. */
export const DEFAULT_CODEX_MODELS = MODEL_CATALOG.codex;

/** Concise summaries for built-in presets */
export const PRESET_SUMMARIES = Object.fromEntries(Object.entries(PRESETS).map(([key, p]) => [key, p.name]));

/** Canonical provider groupings for picker menus and model list output. */
export const SUBSCRIPTION_PROVIDERS = [
  "codex",
  "antigravity",
  "claude",
  "opencode",
  "commandcode",
  "copilot",
  "cursor",
  "ollama",
];

/** Direct-API providers use env keys only; keys are never stored in config. */
export const DIRECT_API_PROVIDERS = [
  "openai-api",
  "anthropic-api",
  "gemini-api",
  "compat-api",
];

/** Strip ANSI color sequences for accurate visible length calculation */
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex -- matching ESC is the point
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

      // The server's list is authoritative: it is what this account can run.
      // Pinning the built-in Astra/Sol entries on top offered models that
      // Codex then rejected at the first turn with `model_not_found`.
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
 * List locally installed Ollama models, with the same short-timeout-and-fallback
 * shape getAgyModels uses so the picker can never hang.
 *
 * @returns {Promise<Array<{id: string, name: string, desc?: string}>>}
 */
export async function getOllamaModels() {
  return new Promise((resolve) => {
    let stdout = "";
    let proc;
    try {
      proc = safeSpawn(findOllamaBinary(), ["list"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve([]);
    }, 4000);

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        resolve([]);
        return;
      }
      const models = [];
      for (const line of stdout.trim().split("\n").slice(1)) {
        const id = line.trim().split(/\s+/)[0];
        if (id) models.push({ id, name: id, desc: "local Ollama model" });
      }
      resolve(models);
    });
  });
}


/**
 * Models appropriate for the chosen provider.
 *
 * Previously every non-Codex provider was shown the Antigravity list, so
 * selecting `anthropic-api` could persist `orchestratorModel: gemini-3.8-flash`.
 *
 * @param {string} provider
 * @returns {Promise<Array<{id: string, name?: string, desc?: string}>>}
 */
export async function modelsForProvider(provider) {
  switch (provider) {
    case "codex":
      return getOrchestratorModels();
    case "antigravity":
      return getAgyModels();
    case "ollama": {
      const live = await getOllamaModels();
      return live.length > 0 ? live : [{ id: "llama3.1", name: "llama3.1", desc: "Ollama default" }];
    }
    default: {
      if (MODEL_CATALOG[provider]) return MODEL_CATALOG[provider];
      // Open providers (compat-api, opencode, …) take any id their setup
      // defines, so the whole catalog is offered as suggestions.
      if (OPEN_MODEL_PROVIDERS.includes(provider)) return allKnownModels();
      const matching = allKnownModels().filter((m) => providerOffersModel(provider, m.id));
      return matching.length > 0 ? matching : allKnownModels();
    }
  }
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
        const isCurrent = presetMatches(key, config);
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

    // 2. Orchestrator Model Picker (Provider-First, grouped Subscription CLIs / Direct API)
    if (action === "orchestrator") {
      mainIndex = 1;
      // Flat ordered list: Subscription CLIs first, then Direct API (promptSelect has no section rows).
      const providerItems = [
        {
          label: "[Subscription] Codex (OpenAI)",
          value: "codex",
          hint: "ChatGPT 6 Astra, Sol, Terra, Luna, GPT-5.5",
          isCurrent: config.orchestratorProvider === "codex",
        },
        {
          label: "[Subscription] Antigravity (Google / Anthropic)",
          value: "antigravity",
          hint: "Gemini 3.8, 3.7, Claude Opus, Claude Sonnet, GPT-OSS",
          isCurrent: config.orchestratorProvider === "antigravity",
        },
        { label: "[Subscription] Claude", value: "claude", hint: "Claude Code subscription CLI", isCurrent: config.orchestratorProvider === "claude" },
        { label: "[Subscription] OpenCode", value: "opencode", hint: "OpenCode subscription CLI", isCurrent: config.orchestratorProvider === "opencode" },
        { label: "[Subscription] CommandCode", value: "commandcode", hint: "CommandCode subscription CLI", isCurrent: config.orchestratorProvider === "commandcode" },
        { label: "[Subscription] Copilot", value: "copilot", hint: "GitHub Copilot CLI subscription", isCurrent: config.orchestratorProvider === "copilot" },
        { label: "[Subscription] Cursor", value: "cursor", hint: "Cursor Agent subscription", isCurrent: config.orchestratorProvider === "cursor" },
        { label: "[Subscription] Ollama", value: "ollama", hint: "Ollama local runner", isCurrent: config.orchestratorProvider === "ollama" },
        { label: "[Direct API] OpenAI API", value: "openai-api", hint: "OPENAI_API_KEY (env only, never stored)", isCurrent: config.orchestratorProvider === "openai-api" },
        { label: "[Direct API] Anthropic API", value: "anthropic-api", hint: "ANTHROPIC_API_KEY (env only, never stored)", isCurrent: config.orchestratorProvider === "anthropic-api" },
        { label: "[Direct API] Gemini API", value: "gemini-api", hint: "GEMINI_API_KEY (env only, never stored)", isCurrent: config.orchestratorProvider === "gemini-api" },
        { label: "[Direct API] OpenAI-Compatible", value: "compat-api", hint: "COMPAT_BASE_URL + optional COMPAT_API_KEY (env only)", isCurrent: config.orchestratorProvider === "compat-api" },
        { label: "← Back", value: "cancel", hint: "Return to main menu" },
      ];

      const provider = await promptSelect({
        title: "Select Orchestrator Provider (Subscription CLIs / Direct API)",
        items: providerItems,
      });

      if (!provider || provider === "cancel") continue;

      const models = await modelsForProvider(provider);

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

    // 3. Worker Model Picker (Provider-First, grouped Subscription CLIs / Direct API)
    if (action === "worker") {
      mainIndex = 2;
      // Flat ordered list: Subscription CLIs first, then Direct API (promptSelect has no section rows).
      const providerItems = [
        {
          label: "[Subscription] Antigravity (Google / Anthropic)",
          value: "antigravity",
          hint: "Gemini 3.8, 3.7, Claude Opus, Claude Sonnet, GPT-OSS",
          isCurrent: config.workerProvider === "antigravity",
        },
        {
          label: "[Subscription] Codex (OpenAI)",
          value: "codex",
          hint: "ChatGPT 6 Astra, Sol, Terra, Luna, GPT-5.5",
          isCurrent: config.workerProvider === "codex",
        },
        { label: "[Subscription] Claude", value: "claude", hint: "Claude Code subscription CLI", isCurrent: config.workerProvider === "claude" },
        { label: "[Subscription] OpenCode", value: "opencode", hint: "OpenCode subscription CLI", isCurrent: config.workerProvider === "opencode" },
        { label: "[Subscription] CommandCode", value: "commandcode", hint: "CommandCode subscription CLI", isCurrent: config.workerProvider === "commandcode" },
        { label: "[Subscription] Copilot", value: "copilot", hint: "GitHub Copilot CLI subscription", isCurrent: config.workerProvider === "copilot" },
        { label: "[Subscription] Cursor", value: "cursor", hint: "Cursor Agent subscription", isCurrent: config.workerProvider === "cursor" },
        { label: "[Subscription] Ollama", value: "ollama", hint: "Ollama local runner", isCurrent: config.workerProvider === "ollama" },
        { label: "[Direct API] OpenAI API", value: "openai-api", hint: "OPENAI_API_KEY (env only, never stored)", isCurrent: config.workerProvider === "openai-api" },
        { label: "[Direct API] Anthropic API", value: "anthropic-api", hint: "ANTHROPIC_API_KEY (env only, never stored)", isCurrent: config.workerProvider === "anthropic-api" },
        { label: "[Direct API] Gemini API", value: "gemini-api", hint: "GEMINI_API_KEY (env only, never stored)", isCurrent: config.workerProvider === "gemini-api" },
        { label: "[Direct API] OpenAI-Compatible", value: "compat-api", hint: "COMPAT_BASE_URL + optional COMPAT_API_KEY (env only)", isCurrent: config.workerProvider === "compat-api" },
        { label: "← Back", value: "cancel", hint: "Return to main menu" },
      ];

      const provider = await promptSelect({
        title: "Select Worker Provider (Subscription CLIs / Direct API)",
        items: providerItems,
      });

      if (!provider || provider === "cancel") continue;

      const models = await modelsForProvider(provider);

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

      setConfigValue("workerProvider", provider);
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
        const levels = EFFORT_LEVELS.map((lvl) => ({
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
        const levels = EFFORT_LEVELS.map((lvl) => ({
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
}
