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
import { EFFORT_LEVELS, LEGACY_MODEL_IDS } from "./models.js";

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
  orchestratorModel: "gpt-6-astra",
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

/**
 * Named model pairings. Each names its provider explicitly: Claude models run
 * through Claude Code (`claude`) or through Antigravity, and the preset says
 * which. Models checked against Claude Code 2.1.307 and agy 1.2.7 (2026-10).
 */
export const PRESETS = {
  default: {
    name: "Astra Low + Gemini 3.8 Medium",
    description: "Everyday development (ChatGPT + Google AI Pro)",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "gpt-6-astra",
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
      orchestratorModel: "gpt-6-astra",
      reasoningEffort: "medium",
      workerProvider: "antigravity",
      workerModel: "gemini-3.8-flash",
      workerEffort: "high",
    },
  },
  speed: {
    name: "GPT-6 Luna Low + Gemini 3.8 Low",
    description: "High-speed iteration and fast turnaround",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "gpt-6-luna",
      reasoningEffort: "low",
      workerProvider: "antigravity",
      workerModel: "gemini-3.8-flash",
      workerEffort: "low",
    },
  },
  claude: {
    name: "Opus 5.5 + Haiku 5.5 (Claude Code)",
    description: "Everything on your Claude subscription, through the official Claude Code CLI",
    config: {
      orchestratorProvider: "claude",
      orchestratorModel: "claude-opus-5-5",
      reasoningEffort: "medium",
      workerProvider: "claude",
      workerModel: "claude-haiku-5-5",
      workerEffort: "low",
    },
  },
  "claude-sonnet": {
    name: "Sonnet 5.5 + Haiku 5.5 (Claude Code)",
    description: "Lighter Claude Code pairing that stretches subscription usage",
    config: {
      orchestratorProvider: "claude",
      orchestratorModel: "claude-sonnet-5-5",
      reasoningEffort: "low",
      workerProvider: "claude",
      workerModel: "claude-haiku-5-5",
      workerEffort: "low",
    },
  },
  "claude-flash": {
    name: "Opus 5.5 (Claude Code) + Gemini 3.8 Flash",
    description: "Claude Code orchestrator with a high-throughput Antigravity worker",
    config: {
      orchestratorProvider: "claude",
      orchestratorModel: "claude-opus-5-5",
      reasoningEffort: "medium",
      workerProvider: "antigravity",
      workerModel: "gemini-3.8-flash",
      workerEffort: "medium",
    },
  },
  "opus-astra": {
    name: "Opus 5.5 (Antigravity) + Astra Low",
    description: "Inverted harness: Claude Opus orchestrator via Google AI Pro + Codex Astra worker",
    config: {
      orchestratorProvider: "antigravity",
      orchestratorModel: "claude-opus-5-5",
      reasoningEffort: "high",
      workerProvider: "codex",
      workerModel: "gpt-6-astra",
      workerEffort: "low",
    },
  },
  "opus-flash": {
    name: "Opus 5.5 (Antigravity) + Gemini 3.8 Flash",
    description: "Claude Opus orchestrator and Gemini worker, both on Google AI Pro",
    config: {
      orchestratorProvider: "antigravity",
      orchestratorModel: "claude-opus-5-5",
      reasoningEffort: "high",
      workerProvider: "antigravity",
      workerModel: "gemini-3.8-flash",
      workerEffort: "medium",
    },
  },
  argon: {
    name: "Gemini 4 Argon + Gemini 3.8 Flash",
    description: "All-Google pairing on Google AI Pro",
    config: {
      orchestratorProvider: "antigravity",
      orchestratorModel: "gemini-4-argon",
      reasoningEffort: "medium",
      workerProvider: "antigravity",
      workerModel: "gemini-3.8-flash",
      workerEffort: "medium",
    },
  },
  test: {
    name: "GPT-6 Luna Low + Gemini 3.8 Low",
    description: "Lowest quota verification (GPT-6 Luna is on every ChatGPT plan)",
    config: {
      orchestratorProvider: "codex",
      orchestratorModel: "gpt-6-luna",
      reasoningEffort: "low",
      workerProvider: "antigravity",
      workerModel: "gemini-3.8-flash",
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
  // Model ids an older Kumo wrote that no CLI accepts (`chatgpt-6-astra`)
  // are read as the model they meant; the file itself is left as it is.
  for (const key of ["orchestratorModel", "workerModel"]) {
    if (LEGACY_MODEL_IDS[merged[key]]) merged[key] = LEGACY_MODEL_IDS[merged[key]];
  }
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
  } else if (key === "reasoningEffort" || key === "workerEffort") {
    const norm = String(value).toLowerCase().trim();
    if (!EFFORT_LEVELS.includes(norm)) {
      throw new Error(`Value for '${key}' must be one of: ${EFFORT_LEVELS.join(", ")}`);
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

// Model helpers live in the one catalog; re-exported for existing importers.
export {
  isCodexModel,
  detectProviderForModel,
  providerForModel,
  resolveModel,
  supportsEffort,
} from "./models.js";
