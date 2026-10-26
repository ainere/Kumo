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
 * settings.js — Global configuration manager for Kumo CLI.
 * Persists user preferences to <KUMO_HOME>/config.json (default `~/.kumo`).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import {
  kumoHome,
  configFile,
  ensureDir,
  atomicWriteJson,
  quarantineCorruptFile,
} from "./paths.js";
import { BANNER_DESIGNS } from "../utils/ui.js";
import {
  ALLOWED_PROVIDERS,
  EFFORT_LEVELS,
  LEGACY_MODEL_IDS,
  MODEL_ID_PATTERN,
  canonicalizeProvider,
} from "./models.js";
import { BUILTIN_ROLE_IDS, emptyRoles, normalizeRoles, sanitizeRoles } from "./roles.js";

// Legacy path for seamless migration. Deliberately anchored to the real home
// directory: the migration must not follow KUMO_HOME.
const LEGACY_FILE = path.join(os.homedir(), ".orchestrator", "config.json");

// The provider list and its aliases live in the catalog (the role
// validation reads them there); re-exported for existing importers.
export { ALLOWED_PROVIDERS, canonicalizeProvider };

/** Safety modes understood by the MCP bridge's write tools. */
export const SAFETY_MODES = ["autonomous", "diff-review", "interactive"];

/**
 * How much each safety mode asks of a human before a worker writes; higher is stricter.
 * @type {Record<string, number>}
 */
const SAFETY_STRICTNESS = { autonomous: 0, "diff-review": 1, interactive: 2 };

/** Unknown safety modes already reported, so a config read on every call warns once. */
const reportedSafetyModes = new Set();

/**
 * Read a safety mode that came from outside the program (a config file, an
 * environment variable, a flag). Case and padding are forgiven. Anything that
 * is not one of SAFETY_MODES is read as `diff-review`, and reported once: an
 * unknown value must never turn the write gate off.
 *
 * @param {unknown} value
 * @param {string} [source] - where it came from, for the warning
 * @returns {string}
 */
export function normalizeSafetyMode(value, source = "the config") {
  const norm = String(value ?? "").toLowerCase().trim();
  if (SAFETY_MODES.includes(norm)) return norm;
  const key = `${source}: ${String(value)}`;
  if (!reportedSafetyModes.has(key)) {
    reportedSafetyModes.add(key);
    console.warn(
      `[Warning] Unknown safetyMode '${String(value)}' in ${source}; using 'diff-review'. Allowed: ${SAFETY_MODES.join(", ")}.`
    );
  }
  return "diff-review";
}

/**
 * The stricter of two safety modes (an unknown one counts as `diff-review`).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {string}
 */
export function stricterSafetyMode(a, b) {
  const x = normalizeSafetyMode(a);
  const y = normalizeSafetyMode(b);
  return SAFETY_STRICTNESS[x] >= SAFETY_STRICTNESS[y] ? x : y;
}

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
  // How often a running session probes every signed-in CLI for usage limits.
  quotaPollMs: 10000,
  cliBinary: "agy",
  approvalPolicy: "on-request",
  bannerStyle: "cloud",
  safetyMode: "autonomous",
  obsidianVault: "",
  openaiBaseUrl: "",
  anthropicBaseUrl: "",
  geminiBaseUrl: "",
  compatBaseUrl: "",
  // Per-role model assignments and custom roles (see roles.js). Empty: every
  // role runs on the worker above, as before roles existed.
  roles: emptyRoles(),
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
 * The `claude` preset's roles, after the design-build split: Opus designs and
 * reviews (and leads), Sonnet builds and tests, Haiku scouts and researches.
 */
const CLAUDE_ROLES = {
  designer: { provider: "claude", model: "claude-opus-5-5", effort: "medium" },
  reviewer: { provider: "claude", model: "claude-opus-5-5", effort: "medium" },
  builder: { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" },
  tester: { provider: "claude", model: "claude-sonnet-5-5", effort: "low" },
  scout: { provider: "claude", model: "claude-haiku-5-5", effort: "low" },
  researcher: { provider: "claude", model: "claude-haiku-5-5", effort: "low" },
};

/**
 * Named model pairings. Each names its provider explicitly: Claude models run
 * through Claude Code (`claude`) or through Antigravity, and the preset says
 * which. Models checked against Claude Code 2.1.307 and agy 1.2.7 (2026-10).
 *
 * A preset's `roles` lists the built-in roles it assigns; applying it puts
 * every other built-in role back on the shared worker and keeps the user's
 * custom roles (see presetConfig).
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
    name: "Opus 5.5 lead + Sonnet/Haiku roles (Claude Code)",
    description:
      "Opus leads, designs and reviews; Sonnet builds and tests; Haiku scouts and researches. All on your Claude subscription",
    config: {
      orchestratorProvider: "claude",
      orchestratorModel: "claude-opus-5-5",
      reasoningEffort: "medium",
      workerProvider: "claude",
      workerModel: "claude-haiku-5-5",
      workerEffort: "low",
      roles: CLAUDE_ROLES,
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

/** A fresh copy of the defaults: nothing nested is shared with DEFAULT_CONFIG. */
function defaultConfig() {
  return { ...DEFAULT_CONFIG, roles: emptyRoles() };
}

/** Problems already reported, so a config read on every call warns once. */
const reportedRoleProblems = new Set();

/** The provider id of the standalone Gemini CLI, which Google replaced with Antigravity (`agy`). */
const RETIRED_GEMINI_CLI = "gemini-cli";

/** Retired-provider settings already reported, so a config read on every call warns once. */
const reportedRetiredSettings = new Set();

/**
 * Read a config that still names the Gemini CLI, which Kumo no longer drives.
 * The lead and the shared worker become Antigravity on its default model (a
 * Gemini CLI model id means nothing to `agy`); a role assigned to it goes back
 * to the shared worker and keeps its name and prompt; a `gemini` binary
 * becomes the `agy` default. The file itself is left as it is; each change is
 * reported once.
 *
 * @param {Record<string, any>} merged - the config being loaded; changed in place
 * @param {string} file
 */
function retireGeminiCli(merged, file) {
  const retired = (provider) => canonicalizeProvider(provider) === RETIRED_GEMINI_CLI;
  const warn = (message) => {
    const key = `${file}: ${message}`;
    if (reportedRetiredSettings.has(key)) return;
    reportedRetiredSettings.add(key);
    console.warn(`[Warning] Gemini CLI was replaced by Antigravity: ${message} (${file}).`);
  };

  if (retired(merged.orchestratorProvider)) {
    merged.orchestratorProvider = "antigravity";
    merged.orchestratorModel = "";
    warn("orchestratorProvider 'gemini-cli' is read as 'antigravity' on its default model");
  }
  if (retired(merged.workerProvider)) {
    merged.workerProvider = "antigravity";
    merged.workerModel = "";
    warn("workerProvider 'gemini-cli' is read as 'antigravity' on its default model");
  }

  const roles = merged.roles;
  if (roles && typeof roles === "object" && !Array.isArray(roles)) {
    const next = { ...roles };
    /** @type {string[]} */
    const reset = [];
    for (const id of BUILTIN_ROLE_IDS) {
      if (!retired(next[id]?.provider)) continue;
      delete next[id];
      reset.push(id);
    }
    if (Array.isArray(next.custom)) {
      next.custom = next.custom.map((role) => {
        if (!retired(role?.provider)) return role;
        const kept = { ...role };
        delete kept.provider;
        delete kept.model;
        delete kept.effort;
        reset.push(String(role.id));
        return kept;
      });
    }
    if (reset.length > 0) {
      merged.roles = next;
      warn(`the 'gemini-cli' assignment of ${reset.join(", ")} is dropped; ${reset.length === 1 ? "it runs" : "they run"} on the shared worker`);
    }
  }

  const binary = path.basename(String(merged.cliBinary ?? "").trim()).replace(/\.(cmd|exe|bat|ps1)$/i, "");
  if (binary.toLowerCase() === "gemini") {
    // A bare `gemini` was older Kumo's own default, not a choice: switch it quietly.
    if (String(merged.cliBinary).trim() !== "gemini") warn(`cliBinary '${binary}' is read as '${DEFAULT_CONFIG.cliBinary}'`);
    merged.cliBinary = DEFAULT_CONFIG.cliBinary;
  }
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
    return defaultConfig();
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
    return defaultConfig();
  }

  const merged = { ...DEFAULT_CONFIG, ...parsed };
  // A hand-edited tier that is not a known one falls to diff-review, never to no gate at all.
  merged.safetyMode = normalizeSafetyMode(merged.safetyMode, file);
  retireGeminiCli(merged, file);
  // Older configs stored the `gemini` alias; normalize on read so every
  // comparison against `antigravity` in the codebase has one spelling to match.
  merged.orchestratorProvider = canonicalizeProvider(merged.orchestratorProvider);
  merged.workerProvider = canonicalizeProvider(merged.workerProvider);
  // Model ids an older Kumo wrote that no CLI accepts (`chatgpt-6-astra`)
  // are read as the model they meant; the file itself is left as it is.
  for (const key of ["orchestratorModel", "workerModel"]) {
    if (LEGACY_MODEL_IDS[merged[key]]) merged[key] = LEGACY_MODEL_IDS[merged[key]];
  }
  // A hand-edited role that does not validate is left out (and reported)
  // rather than failing every command; the other roles still apply.
  const { roles, problems } = sanitizeRoles(merged.roles);
  merged.roles = roles;
  for (const problem of problems) {
    if (reportedRoleProblems.has(problem)) continue;
    reportedRoleProblems.add(problem);
    console.warn(`[Warning] Ignoring part of 'roles' in ${file}: ${problem}`);
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
  const current = loadConfig();
  current[key] = normalizeConfigValue(key, value);
  saveConfig(current);
  // Deliberately no provider-config sync here: this runs from whatever
  // directory the user happens to be in, and the home directory holds the
  // global ~/.codex/config.toml. Sessions refresh opted-in workspaces instead.
  return current;
}

/**
 * Validate and normalize one config value without saving it. Throws with a
 * message naming the allowed values. Sessions use this for settings that
 * apply to them alone; setConfigValue for the saved defaults.
 *
 * @param {string} key
 * @param {*} value
 * @returns {*} the normalized value
 */
export function normalizeConfigValue(key, value) {
  if (key === "__proto__" || key === "constructor" || key === "prototype" || !(key in DEFAULT_CONFIG)) {
    throw new Error(`Unknown config key '${key}'. Allowed: ${Object.keys(DEFAULT_CONFIG).sort().join(", ")}`);
  }

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
    if (key === "quotaPollMs" && (value < 10000 || value > 3600000)) {
      throw new Error(`Value for 'quotaPollMs' must be between 10000 and 3600000`);
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
    if (!MODEL_ID_PATTERN.test(val)) {
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
  } else if (key === "roles") {
    value = normalizeRoles(value);
  }
  return value;
}

/**
 * The settings a preset applies, given the roles in use now: its built-in
 * role assignments replace the current ones (a role it does not name goes
 * back to the shared worker), and custom roles are kept — they are the
 * user's own, not part of any pairing.
 *
 * @param {string} presetName
 * @param {{ custom?: object[] }} [currentRoles]
 * @returns {Record<string, any>}
 */
export function presetConfig(presetName, currentRoles) {
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset '${presetName}'. Available: ${Object.keys(PRESETS).join(", ")}`);
  }
  const custom = Array.isArray(currentRoles?.custom) ? currentRoles.custom : [];
  return { ...preset.config, roles: structuredClone({ ...(preset.config.roles || {}), custom }) };
}

/**
 * Whether `settings` are what `presetName` would set.
 *
 * @param {string} presetName
 * @param {Record<string, any>} settings
 */
export function presetMatches(presetName, settings) {
  return Object.entries(presetConfig(presetName, settings.roles)).every(([key, value]) =>
    isDeepStrictEqual(settings[key], value)
  );
}

/**
 * Apply a named preset.
 */
export function applyPreset(presetName) {
  const current = loadConfig();
  const updated = { ...current, ...presetConfig(presetName, current.roles) };
  saveConfig(updated);
  return updated;
}

/**
 * Reset config to defaults.
 */
export function resetConfig() {
  saveConfig(DEFAULT_CONFIG);
  return defaultConfig();
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
