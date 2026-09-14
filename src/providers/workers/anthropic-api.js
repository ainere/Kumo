/**
 * anthropic-api.js — Anthropic direct-API worker provider adapter.
 */

import { executeApiTask } from "../api/api-worker.js";

export const PROVIDER_INFO = {
  id: "anthropic-api",
  name: "Anthropic API",
};

export async function executeTask(opts) {
  return executeApiTask({ ...opts, provider: "anthropic-api" });
}
