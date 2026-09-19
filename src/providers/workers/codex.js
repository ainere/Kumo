/**
 * codex.js — OpenAI Codex worker provider adapter.
 * Runs non-interactive worker tasks using `codex exec`.
 */

import { findCodexBinary } from "../orchestrators/codex.js";
import {
  runCliWorker,
  buildCompositePrompt,
  mustUseStdinPrompt,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "codex",
  name: "OpenAI Codex Worker",
};

const PREVIEW_NOTE =
  "You are running in read-only diff preview mode. DO NOT modify any files on disk.\n" +
  "Carefully analyze the workspace and produce a complete unified git diff (--- a/... +++ b/...) " +
  "of the exact changes you propose to make, followed by an impact summary.";

/**
 * Execute a bounded worker task using Codex CLI.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - Task instructions
 * @param {string} [opts.mode] - 'read-only' or 'workspace-write'
 * @param {string[]} [opts.files] - Optional list of relevant files
 * @param {string} [opts.workspace] - Target directory
 * @param {string} [opts.model] - Specific model ID override
 * @param {string} [opts.effort] - Specific reasoning effort override
 * @param {string} [opts.systemPrompt] - System prompt instructions
 * @param {boolean} [opts.previewDiff] - Whether to enforce read-only diff generation
 * @param {number} [opts.timeoutMs] - Execution timeout
 * @param {string} [opts.liveLogPath] - File to tee raw output into
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function executeTask(opts) {
  const {
    prompt,
    files = [],
    workspace = process.cwd(),
    model,
    effort,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findCodexBinary();
  const compositePrompt = buildCompositePrompt({
    prompt,
    systemPrompt,
    previewDiff,
    files,
    previewNote: PREVIEW_NOTE,
  });

  const args = ["exec", "--ephemeral"];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }

  // `codex exec -` reads the prompt from stdin. Only used when argv cannot carry
  // it safely (Windows .cmd shim), so the working POSIX path is unchanged.
  const useStdin = mustUseStdinPrompt(bin, compositePrompt);
  args.push(useStdin ? "-" : compositePrompt);

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Codex",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: useStdin ? compositePrompt : null,
  });
}
