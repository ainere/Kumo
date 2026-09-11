/**
 * registry.js — Open-ended registry of worker providers.
 * Supports Gemini/Antigravity, Codex, Claude Code, OpenCode, CommandCode,
 * and arbitrary CLI agents via generic worker without hardcoding models.
 */

import * as geminiWorker from "./gemini.js";
import * as codexWorker from "./codex.js";
import * as claudeWorker from "./claude.js";
import * as opencodeWorker from "./opencode.js";
import * as commandcodeWorker from "./commandcode.js";
import { createWorker as createGenericWorker } from "./generic.js";

const WORKERS = {
  gemini: geminiWorker,
  antigravity: geminiWorker,
  agy: geminiWorker,
  codex: codexWorker,
  claude: claudeWorker,
  opencode: opencodeWorker,
  commandcode: commandcodeWorker,
};

export function getWorker(id = "gemini") {
  const norm = (id || "gemini").toLowerCase().trim();
  const worker = WORKERS[norm];
  if (worker) {
    return worker;
  }
  // Generic fallback for any arbitrary CLI worker
  return createGenericWorker(norm);
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
