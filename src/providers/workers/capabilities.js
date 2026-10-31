// @ts-check
/**
 * capabilities.js — What each worker provider can do.
 *
 * Kept apart from registry.js, which loads every worker adapter: the config
 * layer and the catalog read these capabilities, and importing the adapters
 * from there would loop back into the config modules they read.
 *
 * Roles restrict access, providers do not: any worker can fill any role. What
 * differs is how a worker reaches the workspace, which is what the bridge
 * routes on.
 */

/**
 * - `canWrite`: the worker can fill a role that writes. True for every
 *   provider; a read-only role stays read-only whatever its model.
 * - `readsWorkspace`: the worker can open files on its own. Workers without it
 *   (HTTP APIs, `ollama run`) only see what the bridge inlines into the prompt,
 *   so a call to them needs `files`.
 * - `writesWorkspace`: the worker edits files itself. Workers without it reply
 *   with a unified diff, which the bridge applies after the same checks as an
 *   approved preview.
 *
 * @typedef {{ canWrite: boolean, readsWorkspace: boolean, writesWorkspace: boolean }} WorkerCapabilities
 */

/** Chat models: files inlined in, a diff back, edits applied by the bridge. @type {WorkerCapabilities} */
const TEXT_ONLY = { canWrite: true, readsWorkspace: false, writesWorkspace: false };
/** Agents with their own file access. @type {WorkerCapabilities} */
const AGENT = { canWrite: true, readsWorkspace: true, writesWorkspace: true };

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
