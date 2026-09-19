/**
 * cursor.js — Cursor Agent worker provider adapter.
 * Runs non-interactive worker tasks using `cursor-agent -p`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  mustUseStdinPrompt,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "cursor",
  name: "Cursor Agent",
};

export function findCursorBinary() {
  if (process.env.CURSOR_BIN) return process.env.CURSOR_BIN;
  return resolveBinary("cursor-agent");
}

export async function executeTask(opts) {
  const {
    prompt,
    mode = "read-only",
    safetyMode = "autonomous",
    files = [],
    workspace = process.cwd(),
    model,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findCursorBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files });

  const args = [];
  if (model) {
    args.push("--model", model);
  }
  if (mode === "workspace-write" && safetyMode === "autonomous") {
    args.push("--force");
  }

  // cursor-agent reads the prompt from stdin when `-p` is given without a value.
  const useStdin = mustUseStdinPrompt(bin, compositePrompt);
  args.push("-p");
  if (!useStdin) {
    args.push(compositePrompt);
  }

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Cursor",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: useStdin ? compositePrompt : null,
  });
}
