/**
 * registry.js — Registry of supported worker providers.
 * Open-ended architecture: easily add new worker providers (Claude worker, OpenAI worker, etc.).
 */

import * as geminiWorker from "./gemini.js";

const WORKERS = {
  gemini: geminiWorker,
};

export function getWorker(id = "gemini") {
  const worker = WORKERS[id.toLowerCase()];
  if (!worker) {
    throw new Error(
      `Unknown worker provider '${id}'. Available workers: ${Object.keys(WORKERS).join(", ")}`
    );
  }
  return worker;
}

export function listWorkers() {
  return Object.entries(WORKERS).map(([id, w]) => ({
    id,
    name: w.PROVIDER_INFO?.name || id,
    defaultModel: w.PROVIDER_INFO?.defaultModel || "unknown",
  }));
}
