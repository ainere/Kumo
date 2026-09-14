/**
 * api-worker.js — Shared worker executor for direct API providers.
 * Composes the same compositePrompt blocks as workers/claude.js
 * ([System Instructions], [DIFF PREVIEW MODE], [Relevant Files], [Task])
 * and runs it single-shot through chatComplete. No subprocess, no disk
 * access: mode/workspace never gate execution, previewDiff is prompt-level
 * only. No SDKs, no streaming, single-shot text only.
 */

import { chatComplete, ApiError } from "./api-transport.js";

const DEFAULT_TIMEOUT_MS = 120000;

export async function executeApiTask({
  provider,
  prompt,
  mode,
  files = [],
  workspace,
  model,
  effort,
  systemPrompt,
  previewDiff = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl,
  config,
} = {}) {
  // mode/workspace intentionally do not gate execution (no subprocess).
  void mode;
  void workspace;

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
      timeoutMs,
      baseUrl,
      config,
    });
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
