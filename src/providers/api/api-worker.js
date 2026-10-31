/**
 * api-worker.js — Shared worker executor for direct API providers.
 * Composes the same compositePrompt blocks as the CLI workers
 * ([System Instructions], [DIFF PREVIEW MODE], [Relevant Files], [Task])
 * and runs it single-shot through chatComplete. No SDKs, no streaming.
 *
 * These providers have no subprocess and no filesystem access, so they cannot
 * satisfy a `workspace-write` request; that is reported as an explicit error
 * rather than a success with an empty diff.
 */

import { chatComplete, ApiError } from "./api-transport.js";
import { loadConfig } from "../../config/settings.js";
import { buildCompositePrompt } from "../workers/cli-runner.js";
import { writeLiveOutput } from "../../utils/process.js";

const DEFAULT_TIMEOUT_MS = 120000;

export async function executeApiTask({
  provider,
  prompt,
  mode = "read-only",
  permission,
  files = [],
  fileContents = [],
  model,
  effort,
  systemPrompt,
  previewDiff = false,
  timeoutMs,
  baseUrl,
  config,
  liveLogPath = null,
} = {}) {
  if (permission === "write" || mode === "workspace-write") {
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: "Direct-API workers do not write files themselves; a write goes through the bridge, which applies the diff they propose.",
      timedOut: false,
    };
  }

  const effectiveConfig = config || loadConfig();
  const effectiveTimeout = timeoutMs ?? effectiveConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // The model sees no filesystem: only paths plus whatever contents the bridge
  // inlined. Without the contents it would describe files it never read.
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents });

  try {
    const { text } = await chatComplete({
      provider,
      model,
      prompt: compositePrompt,
      effort,
      timeoutMs: effectiveTimeout,
      baseUrl,
      config: effectiveConfig,
    });
    // There is no child process to tee, so the REPL tailer only ever sees this.
    writeLiveOutput(liveLogPath, text ?? "");
    return { ok: true, code: 0, stdout: text ?? "", stderr: "", timedOut: false };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        code: 1,
        stdout: "",
        stderr: err.message,
        timedOut: err.status === 0,
      };
    }
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr: err?.message || String(err),
      timedOut: false,
    };
  }
}
