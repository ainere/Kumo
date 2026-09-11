/**
 * opencode.js — OpenCode worker provider adapter.
 */

import { executeGenericTask } from "./generic.js";

export const PROVIDER_INFO = {
  id: "opencode",
  name: "OpenCode Worker",
};

export async function executeTask(opts) {
  return executeGenericTask({
    ...opts,
    command: "opencode",
    bin: process.env.OPENCODE_BIN || "opencode",
  });
}
