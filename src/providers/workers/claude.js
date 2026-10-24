/**
 * claude.js — Anthropic Claude Code worker provider adapter.
 * Runs non-interactive worker tasks using `claude -p`.
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
  id: "claude",
  name: "Anthropic Claude Code Worker",
};

export function findClaudeBinary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // npm installs this as claude.cmd on Windows; the bare name cannot be spawned.
  return resolveBinary("claude");
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

  const bin = findClaudeBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents: opts.fileContents });

  // Flags first, positional prompt last: `["-p", "--model", m, prompt]` makes the
  // CLI read `--model` as the value of `-p`.
  const args = [];
  if (model) {
    args.push("--model", model);
  }
  if (grantsWrite(opts)) {
    args.push("--dangerously-skip-permissions");
  }

  const useStdin = mustUseStdinPrompt(bin, compositePrompt);
  args.push("-p");
  if (!useStdin) {
    args.push(compositePrompt);
  }

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Claude",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: useStdin ? compositePrompt : null,
  });
}
