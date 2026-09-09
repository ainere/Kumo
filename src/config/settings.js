/**
 * settings.js — Global configuration manager for Kumo CLI.
 * Persists user preferences to ~/.kumo/config.json.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".kumo");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Legacy path for seamless migration
const LEGACY_DIR = path.join(os.homedir(), ".orchestrator");
const LEGACY_FILE = path.join(LEGACY_DIR, "config.json");

export const DEFAULT_CONFIG = {
  orchestratorProvider: "codex",
  orchestratorModel: "chatgpt-6-astra",
  reasoningEffort: "low",
  workerProvider: "gemini",
  workerModel: "gemini-3.8-flash",
  workerEffort: "medium",
  timeoutMs: 300000,
  cliBinary: "gemini",
  approvalPolicy: "on-request",
  bannerStyle: "cloud",
};

export const PRESETS = {
  default: {
    name: "Default (ChatGPT Plus + Google AI Pro)",
    description: "Astra Low reasoning + Gemini 3.8 Flash worker (medium effort)",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "chatgpt-6-astra",
      reasoningEffort: "low",
      workerProvider: "gemini",
      workerModel: "gemini-3.8-flash",
      workerEffort: "medium",
    },
  },
  pro: {
    name: "ChatGPT Pro (Higher Quota)",
    description: "Astra Medium reasoning + Gemini 3.8 Flash worker (high effort)",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "chatgpt-6-astra",
      reasoningEffort: "medium",
      workerProvider: "gemini",
      workerModel: "gemini-3.8-flash",
      workerEffort: "high",
    },
  },
  speed: {
    name: "High Speed (Sol + Flash)",
    description: "ChatGPT 5.6 Sol + Gemini 3.8 Flash worker (low effort)",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "chatgpt-5.6-sol",
      reasoningEffort: "low",
      workerProvider: "gemini",
      workerModel: "gemini-3.8-flash",
      workerEffort: "low",
    },
  },
  "gemini-3.7": {
    name: "Gemini 3.7 Fallback",
    description: "Astra Low + Gemini 3.7 Flash worker (medium effort)",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "chatgpt-6-astra",
      reasoningEffort: "low",
      workerProvider: "gemini",
      workerModel: "gemini-3.7-flash",
      workerEffort: "medium",
    },
  },
  test: {
    name: "Testing / Lowest Quota (GPT-5.5 Low + Gemini 3.6 Low)",
    description: "GPT-5.5 Low reasoning + Gemini 3.6 Flash (low effort) (cheapest models for tests)",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "gpt-5.5",
      reasoningEffort: "low",
      workerProvider: "gemini",
      workerModel: "gemini-3.6-flash",
      workerEffort: "low",
    },
  },
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Load settings from ~/.kumo/config.json, merging with defaults.
 * Automatically migrates from ~/.orchestrator/config.json if present.
 */
export function loadConfig() {
  ensureConfigDir();

  // Migrate legacy ~/.orchestrator/config.json if ~/.kumo/config.json doesn't exist yet
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_FILE)) {
    try {
      const legacyContent = fs.readFileSync(LEGACY_FILE, "utf-8");
      fs.writeFileSync(CONFIG_FILE, legacyContent, "utf-8");
    } catch {
      /* ignore */
    }
  }

  if (!fs.existsSync(CONFIG_FILE)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    console.warn(`[Warning] Could not parse ${CONFIG_FILE}, using defaults.`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save settings to ~/.kumo/config.json.
 */
export function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Update a specific key.
 */
export function setConfigValue(key, value) {
  const current = loadConfig();

  // Allow setting any key for forward-compatibility with future providers
  if (typeof DEFAULT_CONFIG[key] === "number") {
    value = parseInt(value, 10);
    if (isNaN(value)) throw new Error(`Value for '${key}' must be a valid number`);
  }

  current[key] = value;
  saveConfig(current);
  return current;
}

/**
 * Apply a named preset.
 */
export function applyPreset(presetName) {
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset '${presetName}'. Available: ${Object.keys(PRESETS).join(", ")}`);
  }
  const current = loadConfig();
  const updated = { ...current, ...preset.config };
  saveConfig(updated);
  return updated;
}

/**
 * Reset config to defaults.
 */
export function resetConfig() {
  saveConfig(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

export function getConfigPath() {
  return CONFIG_FILE;
}
