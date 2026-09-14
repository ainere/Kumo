/**
 * gemini-api.js — Google Gemini direct-API worker provider adapter.
 */

import { executeApiTask } from "../api/api-worker.js";

export const PROVIDER_INFO = {
  id: "gemini-api",
  name: "Google Gemini API",
};

export async function executeTask(opts) {
  return executeApiTask({ ...opts, provider: "gemini-api" });
}
