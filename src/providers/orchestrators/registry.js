/**
 * registry.js — Open-ended registry of orchestrator providers and client factory.
 * Supports Codex, Antigravity/Gemini, Claude Code, OpenCode, CommandCode, Copilot,
 * Cursor, Gemini CLI, Ollama, direct APIs, and arbitrary CLI agents via
 * GenericAppClient without hardcoding models.
 */

import * as codexProvider from "./codex.js";
import { CodexAppClient } from "./codex-client.js";
import { AgyAppClient } from "./agy-client.js";
import { ClaudeAppClient } from "./claude-client.js";
import { OpenCodeAppClient } from "./opencode-client.js";
import { CommandCodeAppClient } from "./commandcode-client.js";
import { CopilotAppClient } from "./copilot-client.js";
import { CursorAppClient } from "./cursor-client.js";
import { GeminiCliAppClient } from "./gemini-cli-client.js";
import { OllamaAppClient } from "./ollama-client.js";
import { OpenAIApiClient } from "../api/openai-api-client.js";
import { AnthropicApiClient } from "../api/anthropic-api-client.js";
import { GeminiApiClient } from "../api/gemini-api-client.js";
import { GenericAppClient } from "./generic-client.js";
import { detectProviderForModel, loadConfig } from "../../config/settings.js";

const ORCHESTRATORS = {
  codex: {
    id: "codex",
    name: "OpenAI Codex CLI",
    createClient: (opts) => new CodexAppClient(opts),
    provider: codexProvider,
  },
  antigravity: {
    id: "antigravity",
    name: "Google Antigravity / Gemini CLI",
    createClient: (opts) => new AgyAppClient(opts),
    provider: null,
  },
  gemini: {
    id: "antigravity",
    name: "Google Antigravity / Gemini CLI",
    createClient: (opts) => new AgyAppClient(opts),
    provider: null,
  },
  agy: {
    id: "antigravity",
    name: "Google Antigravity / Gemini CLI",
    createClient: (opts) => new AgyAppClient(opts),
    provider: null,
  },
  claude: {
    id: "claude",
    name: "Anthropic Claude Code CLI",
    createClient: (opts) => new ClaudeAppClient(opts),
    provider: null,
  },
  opencode: {
    id: "opencode",
    name: "OpenCode CLI",
    createClient: (opts) => new OpenCodeAppClient(opts),
    provider: null,
  },
  commandcode: {
    id: "commandcode",
    name: "CommandCode CLI",
    createClient: (opts) => new CommandCodeAppClient(opts),
    provider: null,
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot CLI",
    createClient: (opts) => new CopilotAppClient(opts),
    provider: null,
  },
  cursor: {
    id: "cursor",
    name: "Cursor Agent",
    createClient: (opts) => new CursorAppClient(opts),
    provider: null,
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    createClient: (opts) => new GeminiCliAppClient(opts),
    provider: null,
  },
  ollama: {
    id: "ollama",
    name: "Ollama Local",
    createClient: (opts) => new OllamaAppClient(opts),
    provider: null,
  },
  "openai-api": {
    id: "openai-api",
    name: "OpenAI API",
    createClient: (opts) => new OpenAIApiClient({ ...opts, provider: "openai-api", config: opts.config || loadConfig() }),
    provider: null,
  },
  "anthropic-api": {
    id: "anthropic-api",
    name: "Anthropic API",
    createClient: (opts) => new AnthropicApiClient({ ...opts, config: opts.config || loadConfig() }),
    provider: null,
  },
  "gemini-api": {
    id: "gemini-api",
    name: "Google Gemini API",
    createClient: (opts) => new GeminiApiClient({ ...opts, config: opts.config || loadConfig() }),
    provider: null,
  },
  "compat-api": {
    id: "compat-api",
    name: "OpenAI-Compatible API",
    createClient: (opts) => new OpenAIApiClient({ ...opts, provider: "compat-api", config: opts.config || loadConfig() }),
    provider: null,
  },
};

/**
 * Get orchestrator adapter by provider ID.
 * @param {string} id
 */
export function getOrchestrator(id = "codex") {
  const norm = (id || "codex").toLowerCase().trim();
  const entry = ORCHESTRATORS[norm];
  if (!entry) {
    return {
      id: norm,
      name: `${norm} CLI`,
      createClient: (opts) => new GenericAppClient({ ...opts, command: norm, bin: norm }),
      provider: null,
    };
  }
  return entry;
}

/**
 * Factory to create an active orchestrator client instance based on configuration.
 *
 * @param {Object} opts
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {string} [opts.workspace]
 * @param {Object} [opts.env]
 * @returns {CodexAppClient | AgyAppClient | ClaudeAppClient | OpenCodeAppClient | CommandCodeAppClient | GenericAppClient}
 */
export function createOrchestratorClient(opts = {}) {
  const detected = detectProviderForModel(opts.model, opts.provider);
  const providerKey = (opts.provider || detected || "codex").toLowerCase().trim();
  const entry = ORCHESTRATORS[providerKey];
  if (entry) {
    return entry.createClient({ ...opts, config: opts.config || loadConfig() });
  }
  // Generic fallback for any arbitrary CLI provider
  return new GenericAppClient({
    ...opts,
    command: providerKey,
    bin: providerKey,
  });
}

/**
 * List all available orchestrator providers.
 */
export function listOrchestrators() {
  const seen = new Set();
  const list = [];
  for (const [key, entry] of Object.entries(ORCHESTRATORS)) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      list.push({
        id: entry.id,
        name: entry.name,
      });
    }
  }
  return list;
}
