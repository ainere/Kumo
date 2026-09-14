/**
 * compat-api.js — OpenAI-compatible direct-API worker provider adapter.
 */

import { executeApiTask } from "../api/api-worker.js";

export const PROVIDER_INFO = {
  id: "compat-api",
  name: "OpenAI-Compatible API",
};

export async function executeTask(opts) {
  return executeApiTask({ ...opts, provider: "compat-api" });
}
