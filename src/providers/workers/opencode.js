/**
 * opencode.js — OpenCode worker provider adapter.
 * Runs non-interactive worker tasks using `opencode -p`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "opencode",
  name: "OpenCode Worker",
};

export function findOpencodeBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  return resolveBinary("opencode");
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

  const bin = findOpencodeBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files });

  const args = [];
  if (model) {
    args.push("--model", model);
  }
  void mode; // opencode -p takes no write-mode flag; previewDiff stays prompt-level.
  // No documented stdin prompt form, so the prompt stays in argv.
  args.push("-p", compositePrompt);

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "OpenCode",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
  });
}
