/**
 * commandcode.js — CommandCode worker provider adapter.
 * Runs non-interactive worker tasks using `commandcode -p`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "commandcode",
  name: "CommandCode Worker",
};

export function findCommandcodeBinary() {
  if (process.env.COMMANDCODE_BIN) return process.env.COMMANDCODE_BIN;
  return resolveBinary("commandcode");
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

  const bin = findCommandcodeBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files });

  const args = [];
  if (model) {
    args.push("--model", model);
  }
  void mode; // commandcode -p takes no write-mode flag; previewDiff stays prompt-level.
  // No documented stdin prompt form, so the prompt stays in argv.
  args.push("-p", compositePrompt);

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "CommandCode",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
  });
}
