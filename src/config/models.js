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
 * models.js — Kumo's one model catalog.
 *
 * Which models each provider offers, the short aliases users type, which
 * provider a bare model id belongs to, and how each provider's plan is named.
 * These lists used to be copied into settings.js, the model picker, the agy
 * runner, the REPL header and `kumo status`, and drifted apart.
 *
 * Where a provider can list its own models (Codex `model/list`, `agy models`,
 * `ollama list`) the live list wins; these entries are the fallback and the
 * source for providers that cannot list (Claude Code, the direct APIs).
 * Verified 2026-10-24 against Claude Code 2.1.307 and agy 1.2.7.
 */

/** @typedef {{ id: string, name: string, desc?: string, alias?: string }} ModelEntry */

/** Provider ids accepted for the lead, the shared worker and each role. */
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

/** How each provider is named to people (tool descriptions, `kumo role list`). */
const PROVIDER_NAMES = {
  codex: "Codex",
  antigravity: "Antigravity",
  claude: "Claude Code",
  opencode: "OpenCode",
  commandcode: "CommandCode",
  copilot: "Copilot CLI",
  cursor: "Cursor",
  "gemini-cli": "Gemini CLI",
  ollama: "Ollama",
  "openai-api": "OpenAI API",
  "anthropic-api": "Anthropic API",
  "gemini-api": "Gemini API",
  "compat-api": "OpenAI-compatible API",
};

/**
 * @param {string} provider
 * @returns {string}
 */
export function providerDisplayName(provider) {
  const id = canonicalizeProvider(provider);
  return PROVIDER_NAMES[id] || id;
}

/**
 * Model ids are interpolated raw into generated TOML and passed to provider
 * CLIs, so they are limited to this alphabet.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

/**
 * Claude models, current generation first. Claude Code takes the full id or
 * an alias (`fable`, `opus`, `sonnet`, `haiku` — each the latest of its line).
 * Source: Anthropic's model table, 2026-10-06.
 */
const CLAUDE_MODELS = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", alias: "fable", desc: "Most capable model, for the hardest reasoning" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", alias: "opus", desc: "Frontier reasoning for planning and review" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", alias: "sonnet", desc: "Speed and capability for everyday coding" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", alias: "haiku", desc: "Fast, low-cost model for worker tasks" },
  { id: "claude-fable-5", name: "Claude Fable 5", desc: "Previous Fable" },
  { id: "claude-opus-5", name: "Claude Opus 5", desc: "Previous Opus" },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", desc: "Previous Sonnet" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", desc: "Previous Haiku" },
];

/**
 * Codex models with ChatGPT sign-in, per OpenAI's Codex models page
 * (2026-10-24). The ids are `gpt-…` slugs; Kumo used to invent
 * `chatgpt-6-astra` / `chatgpt-5.6-sol`, which Codex rejected with
 * `model_not_found`. GPT-5.5 retired from ChatGPT sign-in on 2026-10-14,
 * GPT-5.4 and GPT-5.2 before it. An account sees only what its plan
 * includes, and an older Codex CLI may not know the newest models — the live
 * `model/list` is authoritative for a given account and CLI.
 */
const CODEX_MODELS = [
  { id: "gpt-6-astra", name: "GPT-6 Astra", alias: "astra", desc: "Most capable model for complex work" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", alias: "sol", desc: "Near-Astra quality at lower cost; recommended for complex coding" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", alias: "luna", desc: "Most efficient model for focused, high-volume tasks" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", desc: "Previous Sol" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", desc: "Older; available during the GPT-6 rollout" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", alias: "terra", desc: "Older; available during the GPT-6 rollout" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", desc: "Older; available during the GPT-6 rollout" },
];

/** Reasoning effort levels Kumo accepts; Codex, Claude Code and agy all take each of them. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Model ids Kumo once wrote that no CLI accepts, mapped to what they meant.
 * Applied when a config is loaded, so an old config keeps working.
 */
export const LEGACY_MODEL_IDS = {
  "chatgpt-6-astra": "gpt-6-astra",
  "chatgpt-5.6-sol": "gpt-5.6-sol",
  // An Antigravity id that agy no longer offers.
  "claude-opus-4-6-thinking": "claude-opus-5-5",
};

/** `agy models` lists each of these with -low/-medium/-high variants; Kumo keeps the base id and passes effort separately. */
const ANTIGRAVITY_MODELS = [
  { id: "gemini-4-argon", name: "Gemini 4 Argon", alias: "argon", desc: "Google's frontier model" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", alias: "flash", desc: "High-throughput worker model" },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", desc: "Claude via Google AI Pro" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", desc: "Claude via Google AI Pro" },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B", alias: "oss", desc: "Open-weights model" },
];

/** @type {Record<string, ModelEntry[]>} */
export const MODEL_CATALOG = {
  codex: CODEX_MODELS,
  antigravity: ANTIGRAVITY_MODELS,
  claude: CLAUDE_MODELS,
  "anthropic-api": CLAUDE_MODELS.filter((m) => m.id !== "claude-fable-5-1"),
  "openai-api": CODEX_MODELS,
  "gemini-api": ANTIGRAVITY_MODELS.filter((m) => m.id.startsWith("gemini-")),
};

/** Providers whose model id is whatever the user's local setup defines; any id is accepted. */
export const OPEN_MODEL_PROVIDERS = ["ollama", "compat-api", "opencode", "commandcode", "copilot", "cursor", "gemini-cli"];

/** Every catalogued model, once each. */
export function allKnownModels() {
  const seen = new Map();
  for (const list of Object.values(MODEL_CATALOG)) {
    for (const m of list) if (!seen.has(m.id)) seen.set(m.id, m);
  }
  return [...seen.values()];
}

/** Short names users type, mapped to model ids. */
const ALIASES = (() => {
  const map = new Map();
  // Every list, not the de-duplicated one: a model can carry its alias in
  // only one of the providers that offer it.
  for (const list of Object.values(MODEL_CATALOG)) {
    for (const m of list) if (m.alias) map.set(m.alias, m.id);
  }
  // Spellings people use besides the catalog aliases.
  for (const [from, to] of [
    ...Object.entries(LEGACY_MODEL_IDS),
    ["gpt-6", "gpt-6-astra"],
    ["6-astra", "gpt-6-astra"],
    ["chatgpt-6", "gpt-6-astra"],
    ["6.1-sol", "gpt-6.1-sol"],
    ["gpt-6.1", "gpt-6.1-sol"],
    ["6-sol", "gpt-6-sol"],
    ["6-luna", "gpt-6-luna"],
    ["5.6-sol", "gpt-5.6-sol"],
    ["5.6-terra", "gpt-5.6-terra"],
    ["5.6-luna", "gpt-5.6-luna"],
    ["claude-opus", "claude-opus-5-5"],
    ["opus-5.5", "claude-opus-5-5"],
    ["claude-sonnet", "claude-sonnet-5-5"],
    ["sonnet-5.5", "claude-sonnet-5-5"],
    ["claude-haiku", "claude-haiku-5-5"],
    ["haiku-5.5", "claude-haiku-5-5"],
    ["claude-fable", "claude-fable-5-1"],
    ["3.8", "gemini-3.8-flash"],
    ["3.8-flash", "gemini-3.8-flash"],
    ["gemini-3.8", "gemini-3.8-flash"],
    ["gemini-4", "gemini-4-argon"],
    ["120b", "gpt-oss-120b"],
    ["gpt-oss", "gpt-oss-120b"],
  ]) {
    map.set(from, to);
  }
  return map;
})();

/**
 * Resolve an alias ("opus", "flash", "luna") to a model id. Anything else is
 * returned unchanged, so any model a provider accepts can still be named.
 *
 * @param {string} input
 * @returns {string}
 */
export function resolveModel(input) {
  if (!input) return input;
  return ALIASES.get(String(input).toLowerCase().trim()) || input;
}

// gpt-<digit>… is Codex; gpt-oss-… (an Antigravity open-weights model) is not.
const CODEX_MODEL_RE = /^(chatgpt\b|gpt-\d|gpt-reserve\b|astra\b|sol\b|terra\b|luna\b)/i;

/**
 * The provider a model id belongs to when nothing else says.
 *
 * Claude models go to Claude Code, their maker's own CLI; Antigravity also
 * offers some of them, and keeps them when it is already the provider (see
 * {@link providerForModel}).
 *
 * @param {string} model
 * @param {string|null} [preferredProvider] - returned as is when given (an explicit choice)
 * @returns {string}
 */
export function detectProviderForModel(model, preferredProvider = null) {
  if (preferredProvider) {
    const p = preferredProvider.toLowerCase().trim();
    if (p === "gemini" || p === "agy") return "antigravity";
    return p;
  }

  if (!model) return "codex";
  const norm = model.toLowerCase().trim();

  if (CODEX_MODEL_RE.test(norm)) return "codex";
  // gemini-cli-* also starts with gemini-, so it is checked first.
  if (norm.startsWith("gemini-cli")) return "gemini-cli";
  if (norm.startsWith("gemini-") || norm.includes("gpt-oss")) return "antigravity";
  if (norm.startsWith("claude-") || /\b(opus|sonnet|haiku|fable)\b/.test(norm)) return "claude";
  if (norm.startsWith("opencode") || norm.startsWith("open-code")) return "opencode";
  if (norm.startsWith("commandcode") || norm.startsWith("command-code")) return "commandcode";
  if (norm.startsWith("copilot")) return "copilot";
  if (norm.startsWith("cursor")) return "cursor";
  if (norm.startsWith("ollama")) return "ollama";
  return "codex";
}

/**
 * Whether `provider` can run `model`: it is in the provider's catalog, or the
 * provider accepts any id.
 *
 * @param {string} provider
 * @param {string} model
 */
export function providerOffersModel(provider, model) {
  if (OPEN_MODEL_PROVIDERS.includes(provider)) return true;
  const list = MODEL_CATALOG[provider];
  if (!list) return true; // an operator-configured generic CLI
  return list.some((m) => m.id === model);
}

/**
 * The provider whose catalog lists `model` when `provider` keeps a catalog
 * that does not; null when `provider` may well run it. Catches a model id
 * handed to the wrong CLI (a Claude id on Codex), which fails only at the
 * first call, without refusing ids that are merely newer than the catalog.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {string|null}
 */
export function modelBelongsElsewhere(provider, model) {
  if (providerOffersModel(provider, model)) return null;
  for (const [other, list] of Object.entries(MODEL_CATALOG)) {
    if (other !== provider && list.some((m) => m.id === model)) return other;
  }
  return null;
}

/**
 * A model's catalog name ("Claude Sonnet 5.5"), or its id when uncatalogued.
 *
 * @param {string} model
 * @param {string|null} [provider]
 * @returns {string}
 */
export function modelDisplayName(model, provider = null) {
  const own = provider ? MODEL_CATALOG[canonicalizeProvider(provider)] : null;
  const entry = own?.find((m) => m.id === model) || allKnownModels().find((m) => m.id === model);
  return entry ? entry.name : String(model || "");
}

/**
 * The provider to use when switching to `model` from `currentProvider`.
 *
 * Keeps the current provider when it offers the model — `/model opus` on
 * Antigravity stays on Antigravity — and otherwise picks the model's own
 * provider. Always keeping the current one sent Claude model ids to Codex,
 * which rejected them at the first turn.
 *
 * @param {string} model
 * @param {string|null} [currentProvider]
 * @returns {string}
 */
export function providerForModel(model, currentProvider = null) {
  const current = currentProvider ? detectProviderForModel(null, currentProvider) : null;
  if (current && providerOffersModel(current, model)) return current;
  return detectProviderForModel(model);
}

/**
 * Check if a given model or provider configuration corresponds to Codex.
 *
 * @param {string} model
 * @param {string|null} [provider]
 */
export function isCodexModel(model, provider = null) {
  if (provider === "codex") return true;
  if (provider) return false;
  if (!model) return false;
  const norm = model.toLowerCase().trim();
  if (norm.startsWith("gemini-") || norm.startsWith("claude-") || norm.includes("gpt-oss")) return false;
  return CODEX_MODEL_RE.test(norm);
}

/**
 * Whether Antigravity takes `--effort` for this model. Its Gemini and
 * open-weights models do; for Claude models agy picks the effort itself.
 *
 * @param {string} model
 */
export function supportsEffort(model) {
  if (!model) return false;
  const norm = model.toLowerCase().trim();
  if (norm.startsWith("gpt-oss")) return true;
  if (norm.startsWith("claude-") || /\b(opus|sonnet|haiku|fable)\b/.test(norm)) return false;
  if (/-(low|medium|high)$/.test(norm)) return false;
  return norm.startsWith("gemini-") || norm.startsWith("chatgpt-") || /^gpt-\d/.test(norm);
}

/**
 * How a role's plan is named in the header and `kumo status`.
 *
 * @param {string} provider
 * @param {string} model
 * @param {{ planType?: string }|null} [limits] - live limits, when the provider reports a plan
 * @returns {string}
 */
export function planLabel(provider, model, limits = null) {
  const p = detectProviderForModel(model, provider);
  if (p.endsWith("-api")) return `Direct API (${p})`;
  if (p === "codex") return limits?.planType || "ChatGPT";
  if (p === "claude") return "Claude subscription";
  if (p === "antigravity") {
    if (/claude|anthropic/i.test(model || "")) return "Anthropic via Antigravity";
    if (/gpt|openai/i.test(model || "")) return "OpenAI via Antigravity";
    return "Google AI Pro";
  }
  return p;
}
