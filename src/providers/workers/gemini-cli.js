/**
 * gemini-cli.js — Gemini CLI worker provider adapter.
 * Runs non-interactive worker tasks using the standalone `gemini` binary
 * (`GEMINI_BIN`), distinct from the `agy` binary used by `antigravity`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  mustUseStdinPrompt,
  grantsWrite,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "gemini-cli",
  name: "Gemini CLI",
};

export function findGeminiCliBinary() {
  if (process.env.GEMINI_BIN) return process.env.GEMINI_BIN;
  return resolveBinary("gemini");
}

export async function executeTask(opts) {
  const {
    prompt,
    files = [],
    workspace = process.cwd(),
    model,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findGeminiCliBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents: opts.fileContents });

  // Flags first, positional prompt last.
  const args = [];
  if (model) {
    args.push("-m", model);
  }
  if (grantsWrite(opts)) {
    args.push("-y", "--approval-mode", "yolo");
  }

  // The Gemini CLI reads the prompt from stdin when `-p` carries no value.
  const useStdin = mustUseStdinPrompt(bin, compositePrompt);
  args.push("-p");
  if (!useStdin) {
    args.push(compositePrompt);
  }

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Gemini CLI",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: useStdin ? compositePrompt : null,
  });
}
