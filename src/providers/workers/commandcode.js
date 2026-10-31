/**
 * commandcode.js — CommandCode worker provider adapter.
 * Runs non-interactive worker tasks using `commandcode -p`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  grantsWrite,
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
    files = [],
    workspace = process.cwd(),
    model,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findCommandcodeBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents: opts.fileContents });

  const args = [];
  if (model) {
    args.push("--model", model);
  }
  if (grantsWrite(opts)) {
    // Headless mode denies file edits and shell commands unless --yolo is
    // passed; --permission-mode yolo does not lift that, and accept-edits would
    // still refuse the shell a tester or builder runs. The user's deny and ask
    // rules still apply under --yolo.
    args.push("--yolo");
  } else {
    // Plan mode denies every mutation ahead of the user's allow rules (only a
    // plan file under ~/.commandcode/plans may be written), so settings that
    // allow edits cannot let a read-only role change the workspace.
    args.push("--permission-mode", "plan");
  }
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
