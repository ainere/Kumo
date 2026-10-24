/**
 * settings.js — Global configuration manager for Kumo CLI.
 * Persists user preferences to <KUMO_HOME>/config.json (default `~/.kumo`).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  kumoHome,
  configFile,
  ensureDir,
  atomicWriteJson,
  quarantineCorruptFile,
} from "./paths.js";
import { BANNER_DESIGNS } from "../utils/ui.js";

// Legacy path for seamless migration. Deliberately anchored to the real home
// directory: the migration must not follow KUMO_HOME.
const LEGACY_FILE = path.join(os.homedir(), ".orchestrator", "config.json");

/** Provider ids accepted for `orchestratorProvider` / `workerProvider`. */
export const ALLOWED_PROVIDERS = [
  "codex",
  "antigravity",
  "claude",
  "opencode",
  "commandcode",
  "copilot",
  "cursor",
  "gemini-cli",
  "ollama",
  "openai-api",
  "anthropic-api",
  "gemini-api",
  "compat-api",
];

/**
 * Fold provider aliases onto their canonical id. `gemini` and `agy` are both
 * spellings of the Antigravity CLI provider.
 *
 * @param {string} id
 * @returns {string}
 */
export function canonicalizeProvider(id) {
  const norm = String(id ?? "").toLowerCase().trim();
  if (norm === "gemini" || norm === "agy") return "antigravity";
  return norm;
}

/** Safety modes understood by the MCP bridge's write tools. */
export const SAFETY_MODES = ["autonomous", "diff-review", "interactive"];

/** Approval policies accepted by Codex's `approval_policy` TOML key. */
// `on-failure` is no longer in Codex's AskForApproval enum (app-server schema, codex-cli 0.153).
export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"];

/**
 * A base URL is safe when it is https, or plain http pointed at loopback.
 * Plaintext to a remote host would leak the API key on the wire.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isSafeBaseUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export const DEFAULT_CONFIG = {
  orchestratorProvider: "codex",
  orchestratorModel: "chatgpt-6-astra",
  reasoningEffort: "low",
  workerProvider: "antigravity",
  workerModel: "gemini-3.8-flash",
  workerEffort: "medium",
  timeoutMs: 300000,
  turnTimeoutMs: 1800000,
  cliBinary: "agy",
  approvalPolicy: "on-request",
  bannerStyle: "cloud",
  safetyMode: "autonomous",
  trustWorkspace: true,
  obsidianVault: "",
  openaiBaseUrl: "",
  anthropicBaseUrl: "",
  geminiBaseUrl: "",
  compatBaseUrl: "",
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
      workerProvider: "antigravity",
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
      workerProvider: "antigravity",
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
      workerProvider: "antigravity",
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
      workerProvider: "antigravity",
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
      workerProvider: "antigravity",
      workerModel: "gemini-3.6-flash",
      workerEffort: "low",
    },
  },
};

function ensureConfigDir() {
  ensureDir(kumoHome());
}

/**
 * Load settings from <KUMO_HOME>/config.json, merging with defaults.
 * Automatically migrates from ~/.orchestrator/config.json if present.
 */
export function loadConfig() {
  ensureConfigDir();
  const file = configFile();

  // Migrate legacy ~/.orchestrator/config.json if <KUMO_HOME>/config.json doesn't exist yet
  if (!fs.existsSync(file) && fs.existsSync(LEGACY_FILE)) {
    try {
      atomicWriteJson(file, JSON.parse(fs.readFileSync(LEGACY_FILE, "utf-8")));
    } catch {
      /* ignore */
    }
  }

  if (!fs.existsSync(file)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    // Never silently discard a user's settings: quarantine, then fall back.
    const moved = quarantineCorruptFile(file);
    console.warn(
      moved
        ? `[Warning] Could not parse ${file}; moved to ${moved} and using defaults.`
        : `[Warning] Could not parse ${file}, using defaults.`
    );
    return { ...DEFAULT_CONFIG };
  }

  const merged = { ...DEFAULT_CONFIG, ...parsed };
  // Older configs stored the `gemini` alias; normalize on read so every
  // comparison against `antigravity` in the codebase has one spelling to match.
  merged.orchestratorProvider = canonicalizeProvider(merged.orchestratorProvider);
  merged.workerProvider = canonicalizeProvider(merged.workerProvider);
  return merged;
}

/**
 * Save settings to <KUMO_HOME>/config.json (atomic; never truncates on interrupt).
 */
export function saveConfig(config) {
  ensureConfigDir();
  atomicWriteJson(configFile(), config);
}

/**
 * Update a specific key.
 */
export function setConfigValue(key, value) {
  if (key === "__proto__" || key === "constructor" || key === "prototype" || !(key in DEFAULT_CONFIG)) {
    throw new Error(`Unknown config key '${key}'. Allowed: ${Object.keys(DEFAULT_CONFIG).sort().join(", ")}`);
  }
  const current = loadConfig();

  if (typeof DEFAULT_CONFIG[key] === "boolean") {
    if (typeof value === "boolean") {
      // keep as-is
    } else if (typeof value === "number" && (value === 0 || value === 1)) {
      value = value === 1;
    } else if (typeof value === "string") {
      const norm = value.toLowerCase().trim();
      if (norm === "true" || norm === "1") value = true;
      else if (norm === "false" || norm === "0") value = false;
      else throw new Error(`Value for '${key}' must be a boolean`);
    } else {
      throw new Error(`Value for '${key}' must be a boolean`);
    }
  } else if (typeof DEFAULT_CONFIG[key] === "number") {
    value = parseInt(value, 10);
    if (isNaN(value)) throw new Error(`Value for '${key}' must be a valid number`);
    if (key === "timeoutMs" && (value < 5000 || value > 1800000)) {
      throw new Error(`Value for 'timeoutMs' must be between 5000 and 1800000`);
    }
    if (key === "turnTimeoutMs" && (value < 60000 || value > 14400000)) {
      throw new Error(`Value for 'turnTimeoutMs' must be between 60000 and 14400000`);
    }
  } else if (key === "reasoningEffort") {
    const norm = String(value).toLowerCase().trim();
    if (!["low", "medium", "high", "max"].includes(norm)) {
      throw new Error(`Value for 'reasoningEffort' must be one of: low, medium, high, max`);
    }
    value = norm;
  } else if (key === "workerEffort") {
    const norm = String(value).toLowerCase().trim();
    if (!["low", "medium", "high"].includes(norm)) {
      throw new Error(`Value for 'workerEffort' must be one of: low, medium, high`);
    }
    value = norm;
  } else if (key === "orchestratorProvider" || key === "workerProvider") {
    const canon = canonicalizeProvider(value);
    if (!ALLOWED_PROVIDERS.includes(canon)) {
      throw new Error(`Value for '${key}' must be one of: ${ALLOWED_PROVIDERS.join(", ")}`);
    }
    value = canon;
  } else if (key === "orchestratorModel" || key === "workerModel") {
    // Interpolated raw into generated TOML and passed to provider CLIs.
    const val = String(value ?? "").trim();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(val)) {
      throw new Error(
        `Value for '${key}' must be 1-120 chars of letters, digits, '.', '_' or '-'`
      );
    }
    value = val;
  } else if (key === "cliBinary") {
    // Selects an executable to spawn: bare command name or an existing absolute path.
    const val = String(value ?? "").trim();
    const bare = /^[A-Za-z0-9._-]{1,80}$/.test(val);
    const absolute = path.isAbsolute(val) && fs.existsSync(val);
    if (!bare && !absolute) {
      throw new Error(
        `Value for 'cliBinary' must be a bare command name or an existing absolute path`
      );
    }
    value = val;
  } else if (key === "safetyMode") {
    const norm = String(value).toLowerCase().trim();
    if (!SAFETY_MODES.includes(norm)) {
      throw new Error(`Value for 'safetyMode' must be one of: ${SAFETY_MODES.join(", ")}`);
    }
    value = norm;
  } else if (key === "approvalPolicy") {
    const norm = String(value).toLowerCase().trim();
    if (!APPROVAL_POLICIES.includes(norm)) {
      throw new Error(`Value for 'approvalPolicy' must be one of: ${APPROVAL_POLICIES.join(", ")}`);
    }
    value = norm;
  } else if (key === "bannerStyle") {
    const norm = String(value).toLowerCase().trim();
    const styles = Object.keys(BANNER_DESIGNS);
    if (!styles.includes(norm)) {
      throw new Error(`Value for 'bannerStyle' must be one of: ${styles.join(", ")}`);
    }
    value = norm;
  } else if (key === "obsidianVault") {
    const val = String(value ?? "").trim();
    if (val !== "" && !path.isAbsolute(val)) {
      throw new Error(`Value for 'obsidianVault' must be an absolute path or empty`);
    }
    value = val;
  } else if (
    key === "openaiBaseUrl" ||
    key === "anthropicBaseUrl" ||
    key === "geminiBaseUrl" ||
    key === "compatBaseUrl"
  ) {
    const val = typeof value === "string" ? value.trim() : String(value ?? "").trim();
    if (val !== "" && !isSafeBaseUrl(val)) {
      throw new Error(
        `Value for '${key}' must be an https URL, a plain-http loopback URL, or empty`
      );
    }
    value = val;
  }

  current[key] = value;
  saveConfig(current);
  // Deliberately no provider-config sync here: this runs from whatever
  // directory the user happens to be in, and the home directory holds the
  // global ~/.codex/config.toml. Sessions refresh opted-in workspaces instead.
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
  return configFile();
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
  return /^(chatgpt\b|gpt-5(\b|\.)|astra\b|sol\b|terra\b|luna\b)/i.test(norm);
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
  if (/^(chatgpt\b|gpt-5(\b|\.)|astra\b|sol\b|terra\b|luna\b)/i.test(norm)) {
    return "codex";
  }

  // Gemini CLI model prefix precedes the generic gemini- branch below (gemini-cli-* starts with gemini-).
  if (norm.startsWith("gemini-cli")) {
    return "gemini-cli";
  }

  // Google Antigravity models (Gemini + open-weights)
  if (norm.startsWith("gemini-") || norm.includes("gpt-oss")) {
    return "antigravity";
  }

  // Claude models: supported both by Antigravity (Google AI Pro subscription) and Claude Code
  if (norm.startsWith("claude-") || /\bopus\b/.test(norm) || /\bsonnet\b/.test(norm)) {
    return "antigravity";
  }

  // OpenCode / CommandCode models
  if (norm.startsWith("opencode") || norm.startsWith("open-code")) {
    return "opencode";
  }
  if (norm.startsWith("commandcode") || norm.startsWith("command-code")) {
    return "commandcode";
  }
  // New subscription CLI model prefixes.
  if (norm.startsWith("copilot")) {
    return "copilot";
  }
  if (norm.startsWith("cursor-agent") || norm.startsWith("cursor")) {
    return "cursor";
  }
  if (norm.startsWith("ollama")) {
    return "ollama";
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
 * Check whether a model supports the CLI `--effort` flag in Antigravity.
 * Claude models and models with predefined suffixes do not support `--effort`.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function supportsEffort(model) {
  if (!model) return false;
  const norm = model.toLowerCase().trim();
  if (norm.startsWith("gpt-oss")) return true;
  if (norm.startsWith("claude-") || /\bopus\b/.test(norm) || /\bsonnet\b/.test(norm)) {
    return false;
  }
  if (norm.endsWith("-low") || norm.endsWith("-medium") || norm.endsWith("-high")) {
    return false;
  }
  return norm.startsWith("gemini-") || norm.startsWith("chatgpt-") || norm.startsWith("gpt-5");
}

