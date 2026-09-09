/**
 * registry.js — Registry of supported orchestrator providers.
 * Open-ended architecture: easily add new orchestrator adapters (Claude, Agy, etc.).
 */

import * as codexProvider from "./codex.js";

const ORCHESTRATORS = {
  codex: codexProvider,
};

/**
 * Get orchestrator adapter by provider ID.
 * @param {string} id
 */
export function getOrchestrator(id = "codex") {
  const provider = ORCHESTRATORS[id.toLowerCase()];
  if (!provider) {
    throw new Error(
      `Unknown orchestrator provider '${id}'. Available providers: ${Object.keys(ORCHESTRATORS).join(", ")}`
    );
  }
  return provider;
}

/**
 * List all available orchestrator providers.
 */
export function listOrchestrators() {
  return Object.entries(ORCHESTRATORS).map(([id, p]) => ({
    id,
    name: p.PROVIDER_INFO?.name || id,
    defaultModel: p.PROVIDER_INFO?.defaultModel || "unknown",
  }));
}
