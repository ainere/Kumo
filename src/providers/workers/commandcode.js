/**
 * commandcode.js — CommandCode worker provider adapter.
 */

import { executeGenericTask } from "./generic.js";

export const PROVIDER_INFO = {
  id: "commandcode",
  name: "CommandCode Worker",
};

export async function executeTask(opts) {
  return executeGenericTask({
    ...opts,
    command: "commandcode",
    bin: process.env.COMMANDCODE_BIN || "commandcode",
  });
}
