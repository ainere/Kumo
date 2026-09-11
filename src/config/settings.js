/**
 * settings.js — Global configuration manager for Kumo CLI.
 * Persists user preferences to ~/.kumo/config.json.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { syncAgentConfigs } from "./sync.js";

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
  safetyMode: "autonomous",
  trustWorkspace: true,
  obsidianVault: "",
};

/**
 * Resolve configured Obsidian knowledge vault path.
 * Priority: KUMO_OBSIDIAN_VAULT env var > config.obsidianVault > null
 */
export function getObsidianVaultPath(config = null) {
  if (process.env.KUMO_OBSIDIAN_VAULT) {
    return process.env.KUMO_OBSIDIAN_VAULT;
  }
  const cfg = config || loadConfig();
  return cfg.obsidianVault || null;
}

export const PRESETS = {
  default: {
    name: "Astra Low + Gemini 3.8 Medium",
    description: "Everyday development (ChatGPT Plus + Google AI Pro)",
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
    name: "Astra Medium + Gemini 3.8 High",
    description: "Complex architecture and deeper reasoning (ChatGPT Pro)",
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
    name: "Sol Low + Gemini 3.8 Low",
    description: "High-speed iteration and fast turnaround",
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
    name: "Astra Low + Gemini 3.7 Medium",
    description: "Fallback compatibility worker",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "chatgpt-6-astra",
      reasoningEffort: "low",
      workerProvider: "gemini",
      workerModel: "gemini-3.7-flash",
      workerEffort: "medium",
    },
  },
  "opus-astra": {
    name: "Opus 4.6 Thinking + Astra Low",
    description: "Inverted harness: Claude Opus Orchestrator (Antigravity) + Codex Astra Worker",
    config: {
      orchestratorProvider: "antigravity",
      orchestratorModel: "claude-opus-4-6-thinking",
      reasoningEffort: "high",
      workerProvider: "codex",
      workerModel: "chatgpt-6-astra",
      workerEffort: "low",
    },
  },
  "opus-flash": {
    name: "Opus 4.6 Thinking + Gemini 3.8 Flash",
    description: "Frontier reasoning Orchestrator (Opus) + high-speed Worker (Gemini)",
    config: {
      orchestratorProvider: "antigravity",
      orchestratorModel: "claude-opus-4-6-thinking",
      reasoningEffort: "high",
      workerProvider: "antigravity",
      workerModel: "gemini-3.8-flash",
      workerEffort: "medium",
    },
  },
  test: {
    name: "GPT-5.5 Low + Gemini 3.6 Low",
    description: "Lowest quota verification (ChatGPT Go safe)",
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
  syncAgentConfigs(process.cwd(), current);
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
  syncAgentConfigs(process.cwd(), updated);
  return updated;
}

/**
 * Reset config to defaults.
 */
export function resetConfig() {
  saveConfig(DEFAULT_CONFIG);
  syncAgentConfigs(process.cwd(), DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

export function getConfigPath() {
  return CONFIG_FILE;
}

/**
 * Check if a given model or provider configuration corresponds to Codex.
 * Returns true if provider is 'codex' or the model is a known Codex/OpenAI model.
 */
export function isCodexModel(model, provider = null) {
  if (provider === "codex") return true;
  if (provider === "antigravity" || provider === "gemini" || provider === "claude") return false;
  if (!model) return false;
  const norm = model.toLowerCase().trim();
  if (norm.startsWith("gemini-") || norm.startsWith("claude-") || norm.includes("gpt-oss")) {
    return false;
  }
  return /^(chatgpt|gpt-5\b|gpt-5\.)|astra|sol|terra|luna/i.test(norm);
}

/**
 * Automatically determine the appropriate provider for a given model identifier.
 *
 * @param {string} model
 * @param {string} [preferredProvider=null]
 * @returns {string} provider ID ('codex', 'antigravity', 'claude', 'opencode', 'commandcode')
 */
export function detectProviderForModel(model, preferredProvider = null) {
  if (preferredProvider) {
    const p = preferredProvider.toLowerCase().trim();
    if (p === "gemini" || p === "agy") return "antigravity";
    return p;
  }

  if (!model) return "codex";
  const norm = model.toLowerCase().trim();

  // OpenAI / Codex models
  if (/^(chatgpt|gpt-5\b|gpt-5\.)|astra|sol|terra|luna/i.test(norm)) {
    return "codex";
  }

  // Google Antigravity models (Gemini + open-weights)
  if (norm.startsWith("gemini-") || norm.includes("gpt-oss")) {
    return "antigravity";
  }

  // Claude models: supported both by Antigravity (Google AI Pro subscription) and Claude Code
  if (norm.startsWith("claude-") || norm.includes("opus") || norm.includes("sonnet")) {
    if (preferredProvider === "claude") return "claude";
    return "antigravity";
  }

  // OpenCode / CommandCode models
  if (norm.startsWith("opencode") || norm.startsWith("open-code")) {
    return "opencode";
  }
  if (norm.startsWith("commandcode") || norm.startsWith("command-code")) {
    return "commandcode";
  }

  return "codex";
}

/**
 * Canonical model resolution for any model alias across all providers.
 */
export function resolveModel(input) {
  if (!input) return input;
  const norm = input.toLowerCase().trim();

  // Codex / OpenAI aliases
  if (norm === "astra" || norm === "chatgpt-6" || norm === "6-astra") return "chatgpt-6-astra";
  if (norm === "sol" || norm === "5.6-sol" || norm === "chatgpt-sol") return "chatgpt-5.6-sol";
  if (norm === "terra" || norm === "5.6-terra") return "gpt-5.6-terra";
  if (norm === "luna" || norm === "5.6-luna") return "gpt-5.6-luna";
  if (norm === "gpt-5" || norm === "5.5" || norm === "gpt5") return "gpt-5.5";

  // Anthropic / Claude aliases
  if (norm === "opus" || norm === "opus-4.6" || norm === "claude-opus" || norm === "opus-thinking" || norm === "claude-opus-4.6") {
    return "claude-opus-4-6-thinking";
  }
  if (norm === "sonnet" || norm === "sonnet-4.6" || norm === "claude-sonnet" || norm === "claude-sonnet-4.6") {
    return "claude-sonnet-4-6";
  }

  // Google / Gemini aliases
  if (norm === "flash" || norm === "3.8" || norm === "3.8-flash" || norm === "gemini-3.8") return "gemini-3.8-flash";
  if (norm === "3.7" || norm === "3.7-flash" || norm === "gemini-3.7") return "gemini-3.7-flash";
  if (norm === "3.6" || norm === "3.6-flash" || norm === "gemini-3.6") return "gemini-3.6-flash";
  if (norm === "pro" || norm === "3.1" || norm === "3.1-pro" || norm === "gemini-3.1") return "gemini-3.1-pro";
  if (norm === "oss" || norm === "120b" || norm === "gpt-oss") return "gpt-oss-120b";

  return input;
}

/**
 * Resolve friendly or shorthand model names to canonical model IDs.
 */
export function resolveOrchestratorModel(input) {
  return resolveModel(input);
}

export function resolveWorkerModel(input) {
  return resolveModel(input);
}

/**
 * Check whether a model supports the CLI `--effort` flag in Antigravity.
 * Claude models and models with predefined suffixes do not support `--effort`.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function supportsEffort(model) {
  if (!model) return false;
  const norm = model.toLowerCase().trim();
  if (norm.startsWith("claude-") || norm.includes("opus") || norm.includes("sonnet")) {
    return false;
  }
  if (norm.endsWith("-low") || norm.endsWith("-medium") || norm.endsWith("-high")) {
    return false;
  }
  return norm.startsWith("gemini-") || norm.startsWith("chatgpt-") || norm.startsWith("gpt-5");
}

