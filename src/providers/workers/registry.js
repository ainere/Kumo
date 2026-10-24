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
 * registry.js — Open-ended registry of worker providers.
 * Supports Gemini/Antigravity, Codex, Claude Code, OpenCode, CommandCode,
 * Copilot, Cursor, Gemini CLI, Ollama, direct APIs, and arbitrary CLI agents
 * via generic worker without hardcoding models.
 */

import * as geminiWorker from "./gemini.js";
import * as codexWorker from "./codex.js";
import * as claudeWorker from "./claude.js";
import * as opencodeWorker from "./opencode.js";
import * as commandcodeWorker from "./commandcode.js";
import * as copilotWorker from "./copilot.js";
import * as cursorWorker from "./cursor.js";
import * as geminiCliWorker from "./gemini-cli.js";
import * as ollamaWorker from "./ollama.js";
import * as openaiApiWorker from "./openai-api.js";
import * as anthropicApiWorker from "./anthropic-api.js";
import * as geminiApiWorker from "./gemini-api.js";
import * as compatApiWorker from "./compat-api.js";
import { createWorker as createGenericWorker } from "./generic.js";

const WORKERS = {
  gemini: geminiWorker,
  antigravity: geminiWorker,
  agy: geminiWorker,
  codex: codexWorker,
  claude: claudeWorker,
  opencode: opencodeWorker,
  commandcode: commandcodeWorker,
  copilot: copilotWorker,
  cursor: cursorWorker,
  "gemini-cli": geminiCliWorker,
  ollama: ollamaWorker,
  "openai-api": openaiApiWorker,
  "anthropic-api": anthropicApiWorker,
  "gemini-api": geminiApiWorker,
  "compat-api": compatApiWorker,
};

/** Worker provider ids this registry knows about. */
export const KNOWN_WORKERS = Object.keys(WORKERS);

// What a worker can actually do, so the bridge can refuse a task instead of
// returning invented output. Lives in its own module so the config layer can
// check roles against it without loading every adapter.
export { workerCapabilities } from "./capabilities.js";

/**
 * Resolve a worker provider adapter.
 *
 * An unknown id becomes the name of the executable `createGenericWorker` spawns,
 * so it is never accepted implicitly: MCP tool arguments are model-authored.
 * Only a value the operator configured may opt into the generic path.
 *
 * @param {string} [id]
 * @param {Object} [options]
 * @param {boolean} [options.allowGeneric=false]
 * @returns {{PROVIDER_INFO?: object, executeTask: Function}}
 */
export function getWorker(id = "gemini", { allowGeneric = false } = {}) {
  const norm = (id || "gemini").toLowerCase().trim();
  const worker = WORKERS[norm];
  if (worker) {
    return worker;
  }
  if (allowGeneric) {
    return createGenericWorker(norm);
  }
  throw new Error(
    `Unknown worker provider '${norm}'. Known: ${KNOWN_WORKERS.slice().sort().join(", ")}`
  );
}

export function listWorkers() {
  const seen = new Set();
  const list = [];
  for (const [id, w] of Object.entries(WORKERS)) {
    const canonicalId = w.PROVIDER_INFO?.id || id;
    if (!seen.has(canonicalId)) {
      seen.add(canonicalId);
      list.push({
        id: canonicalId,
        name: w.PROVIDER_INFO?.name || canonicalId,
      });
    }
  }
  return list;
}
