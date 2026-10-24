// @ts-check
/**
 * capabilities.js — What each worker provider can do.
 *
 * Kept apart from registry.js, which loads every worker adapter: the config
 * layer validates roles against these capabilities, and importing the
 * adapters from there would loop back into the config modules they read.
 */

/**
 * - `canWrite`: the worker can modify files in the workspace.
 * - `readsWorkspace`: the worker can open files on its own. Workers without it
 *   (HTTP APIs, `ollama run`) only see what the bridge inlines into the prompt.
 *
 * @typedef {{ canWrite: boolean, readsWorkspace: boolean }} WorkerCapabilities
 */

/** @type {WorkerCapabilities} */
const TEXT_ONLY = { canWrite: false, readsWorkspace: false };
/** @type {WorkerCapabilities} */
const AGENT = { canWrite: true, readsWorkspace: true };

/** @type {Record<string, WorkerCapabilities>} */
const CAPABILITIES = {
  ollama: TEXT_ONLY,
  "openai-api": TEXT_ONLY,
  "anthropic-api": TEXT_ONLY,
  "gemini-api": TEXT_ONLY,
  "compat-api": TEXT_ONLY,
};

/**
 * Capabilities of a worker provider. Unknown ids — operator-configured generic
 * CLIs — are assumed to be agents, which is what the generic adapter drives.
 *
 * @param {string} id
 * @returns {WorkerCapabilities}
 */
export function workerCapabilities(id) {
  return CAPABILITIES[String(id || "").toLowerCase().trim()] || AGENT;
}
