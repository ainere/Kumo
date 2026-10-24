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
 * registry.js — Registry of orchestrator providers and client factory.
 * Supports Codex, Antigravity/Gemini, Claude Code, OpenCode, CommandCode, Copilot,
 * Cursor, Gemini CLI, Ollama, and the four direct-API providers.
 *
 * An arbitrary CLI agent can still be driven through `GenericAppClient`, but only
 * when the caller explicitly opts in — an unknown provider id decides which
 * executable gets spawned, so it is never accepted implicitly.
 */

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
    delegates: true,
    createClient: (opts) => new CodexAppClient(opts),
  },
  antigravity: {
    id: "antigravity",
    name: "Google Antigravity / Gemini CLI",
    delegates: true,
    createClient: (opts) => new AgyAppClient(opts),
  },
  gemini: {
    id: "antigravity",
    name: "Google Antigravity / Gemini CLI",
    delegates: true,
    createClient: (opts) => new AgyAppClient(opts),
  },
  agy: {
    id: "antigravity",
    name: "Google Antigravity / Gemini CLI",
    delegates: true,
    createClient: (opts) => new AgyAppClient(opts),
  },
  claude: {
    id: "claude",
    name: "Anthropic Claude Code CLI",
    delegates: true,
    createClient: (opts) => new ClaudeAppClient(opts),
  },
  opencode: {
    id: "opencode",
    name: "OpenCode CLI",
    delegates: false,
    createClient: (opts) => new OpenCodeAppClient(opts),
  },
  commandcode: {
    id: "commandcode",
    name: "CommandCode CLI",
    delegates: false,
    createClient: (opts) => new CommandCodeAppClient(opts),
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot CLI",
    delegates: false,
    createClient: (opts) => new CopilotAppClient(opts),
  },
  cursor: {
    id: "cursor",
    name: "Cursor Agent",
    delegates: false,
    createClient: (opts) => new CursorAppClient(opts),
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    delegates: false,
    createClient: (opts) => new GeminiCliAppClient(opts),
  },
  ollama: {
    id: "ollama",
    name: "Ollama Local",
    delegates: false,
    createClient: (opts) => new OllamaAppClient(opts),
  },
  "openai-api": {
    id: "openai-api",
    name: "OpenAI API",
    delegates: false,
    createClient: (opts) =>
      new OpenAIApiClient({ ...opts, provider: "openai-api", config: opts.config || loadConfig() }),
  },
  "anthropic-api": {
    id: "anthropic-api",
    name: "Anthropic API",
    delegates: false,
    createClient: (opts) => new AnthropicApiClient({ ...opts, config: opts.config || loadConfig() }),
  },
  "gemini-api": {
    id: "gemini-api",
    name: "Google Gemini API",
    delegates: false,
    createClient: (opts) => new GeminiApiClient({ ...opts, config: opts.config || loadConfig() }),
  },
  "compat-api": {
    id: "compat-api",
    name: "OpenAI-Compatible API",
    delegates: false,
    createClient: (opts) =>
      new OpenAIApiClient({ ...opts, provider: "compat-api", config: opts.config || loadConfig() }),
  },
};

/** Provider ids this registry knows about. */
export const KNOWN_ORCHESTRATORS = Object.keys(ORCHESTRATORS);

function genericEntry(id) {
  return {
    id,
    name: `${id} CLI`,
    delegates: false,
    createClient: (opts) => new GenericAppClient({ ...opts, command: id, bin: id }),
  };
}

/**
 * Whether an orchestrator provider can reach Kumo's worker tools.
 *
 * Only Codex (bridge passed as a thread config override), Claude Code
 * (`--mcp-config`) and Antigravity (`.agents/mcp_config.json`) are wired to the
 * MCP bridge. The others run each prompt through a CLI or HTTP API with no tool
 * access, so they answer on their own and never delegate.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function orchestratorDelegates(id) {
  const entry = ORCHESTRATORS[String(id || "").toLowerCase().trim()];
  return Boolean(entry?.delegates);
}

/**
 * Get orchestrator adapter by provider ID.
 *
 * @param {string} [id]
 * @param {Object} [options]
 * @param {boolean} [options.allowGeneric=false] - permit an unknown id to become
 *   the name of the spawned executable. Only ever set this for a value the user
 *   configured directly.
 * @returns {{id: string, name: string, createClient: (opts: object) => object}}
 */
export function getOrchestrator(id = "codex", { allowGeneric = false } = {}) {
  const norm = (id || "codex").toLowerCase().trim();
  const entry = ORCHESTRATORS[norm];
  if (entry) return entry;
  if (allowGeneric) return genericEntry(norm);
  throw new Error(
    `Unknown orchestrator provider '${norm}'. Known: ${KNOWN_ORCHESTRATORS.slice().sort().join(", ")}`
  );
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
 * @param {string} [opts.safetyMode] - the session's safety mode (agy fixes its permissions at start)
 * @param {Object} [opts.config] - settings to use instead of the saved config
 * @param {boolean} [opts.allowGeneric=false]
 * @returns {object}
 */
export function createOrchestratorClient(opts = {}) {
  const detected = detectProviderForModel(opts.model, opts.provider);
  const providerKey = (opts.provider || detected || "codex").toLowerCase().trim();
  const entry = getOrchestrator(providerKey, { allowGeneric: opts.allowGeneric === true });
  return entry.createClient({ ...opts, config: opts.config || loadConfig() });
}

/**
 * List all available orchestrator providers.
 */
export function listOrchestrators() {
  const seen = new Set();
  const list = [];
  for (const entry of Object.values(ORCHESTRATORS)) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      list.push({ id: entry.id, name: entry.name });
    }
  }
  return list;
}
