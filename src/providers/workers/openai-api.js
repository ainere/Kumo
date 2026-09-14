/**
 * openai-api.js — OpenAI direct-API worker provider adapter.
 */

import { executeApiTask } from "../api/api-worker.js";

export const PROVIDER_INFO = {
  id: "openai-api",
  name: "OpenAI API",
};

export async function executeTask(opts) {
  return executeApiTask({ ...opts, provider: "openai-api" });
}
