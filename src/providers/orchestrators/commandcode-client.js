/**
 * commandcode-client.js — Orchestrator client adapter for CommandCode CLI (`commandcode`).
 */

import { GenericAppClient } from "./generic-client.js";

export class CommandCodeAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "commandcode",
      bin: options.bin || process.env.COMMANDCODE_BIN || "commandcode",
    });
  }
}
