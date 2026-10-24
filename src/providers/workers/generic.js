/**
 * generic.js — Generic worker provider adapter for arbitrary external CLI tools.
 *
 * Reachable only when the operator explicitly configures an unknown provider id
 * (`getWorker(id, { allowGeneric: true })`). Model-supplied provider names are
 * rejected by the registry, because the id becomes the spawned executable.
 */

import {
  runCliWorker,
  buildCompositePrompt,
  grantsWrite,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export function createWorker(commandName) {
  return {
    PROVIDER_INFO: {
      id: commandName,
      name: `${commandName} Worker`,
    },
    async executeTask(opts) {
      return executeGenericTask({ ...opts, command: commandName });
    },
  };
}

export async function executeGenericTask(opts) {
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
    command = "agent",
    bin = command,
  } = opts;

  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents: opts.fileContents });

  const args = [];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("--effort", effort);
  }
  if (grantsWrite(opts)) {
    args.push("--dangerously-skip-permissions");
  }
  // The CLI is unknown, so no stdin contract can be assumed; prompt stays in argv.
  args.push("-p", compositePrompt);

  return runCliWorker({
    providerId: command,
    label: command,
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
  });
}
