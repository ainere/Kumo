/**
 * ollama.js — Ollama local worker provider adapter.
 * Runs non-interactive worker tasks using `ollama run <model> <prompt>`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "ollama",
  name: "Ollama Local",
};

export function findOllamaBinary() {
  if (process.env.OLLAMA_BIN) return process.env.OLLAMA_BIN;
  return resolveBinary("ollama");
}

export async function executeTask(opts) {
  const {
    prompt,
    mode = "read-only",
    files = [],
    workspace = process.cwd(),
    model,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findOllamaBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files });

  void mode; // ollama run takes no write-mode flag; previewDiff stays prompt-level.
  const args = ["run", model || "llama3.1", compositePrompt];

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Ollama",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
  });
}
