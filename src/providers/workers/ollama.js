/**
 * ollama.js — Ollama local worker provider adapter.
 * Runs non-interactive worker tasks using `ollama run <model> <prompt>`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  mustUseStdinPrompt,
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
    files = [],
    fileContents = [],
    workspace = process.cwd(),
    model,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findOllamaBinary();
  // `ollama run` is a plain model call: it cannot open or write files, so the
  // bridge inlines file contents and never routes write tasks here.
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents });

  // `ollama run <model>` reads the prompt from stdin when none is given; that
  // is the only way a multi-line prompt survives a Windows .cmd shim.
  const useStdin = mustUseStdinPrompt(bin, compositePrompt);
  const args = ["run", model || "llama3.1"];
  if (!useStdin) args.push(compositePrompt);

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Ollama",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: useStdin ? compositePrompt : null,
  });
}
