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

import fs from "node:fs";
import { chatComplete, ApiError } from "./api-transport.js";
import { loadConfig } from "../../config/settings.js";

const DEFAULT_TIMEOUT_MS = 120000;

export async function executeApiTask({
  provider,
  prompt,
  mode = "read-only",
  files = [],
  model,
  effort,
  systemPrompt,
  previewDiff = false,
  timeoutMs,
  baseUrl,
  config,
  liveLogPath = null,
} = {}) {
  if (mode === "workspace-write") {
    return {
      ok: false,
      code: 1,
      stdout: "",
      stderr:
        "Direct-API workers cannot modify files; select a CLI worker provider for worker_implement/worker_test.",
      timedOut: false,
    };
  }

  const effectiveConfig = config || loadConfig();
  const effectiveTimeout = timeoutMs ?? effectiveConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let compositePrompt = "";
  if (systemPrompt) {
    compositePrompt += `[System Instructions]\n${systemPrompt}\n\n`;
  }
  if (previewDiff) {
    compositePrompt += `[DIFF PREVIEW MODE]\nProduce a complete unified git diff without modifying files on disk.\n\n`;
  }
  if (files && files.length > 0) {
    compositePrompt += `[Relevant Files]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }
  compositePrompt += `[Task]\n${prompt}`;

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
    if (liveLogPath) {
      try {
        fs.appendFileSync(liveLogPath, text ?? "");
      } catch {
        /* live log is best-effort telemetry */
      }
    }
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
