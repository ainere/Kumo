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
