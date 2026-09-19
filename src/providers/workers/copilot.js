/**
 * copilot.js — GitHub Copilot CLI worker provider adapter.
 * Runs non-interactive worker tasks using `gh copilot -p`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "copilot",
  name: "GitHub Copilot CLI",
};

export function findCopilotBinary() {
  if (process.env.COPILOT_BIN) return process.env.COPILOT_BIN;
  return resolveBinary("gh");
}

export async function executeTask(opts) {
  const {
    prompt,
    mode = "read-only",
    safetyMode = "autonomous",
    files = [],
    workspace = process.cwd(),
    model,
    effort,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findCopilotBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files });

  // Flags first, positional prompt last.
  const args = ["copilot"];
  if (model) {
    args.push("--model", model);
  }
  void effort; // gh copilot has no --effort flag; effort stays a no-op.
  if (mode === "workspace-write" && safetyMode === "autonomous") {
    args.push("--allow-all-tools");
  }
  // `gh copilot` has no documented stdin prompt form, so the prompt stays in argv.
  args.push("-p", compositePrompt);

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Copilot",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
  });
}
