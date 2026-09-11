/**
 * opencode-client.js — Orchestrator client adapter for OpenCode CLI (`opencode`).
 */

import { GenericAppClient } from "./generic-client.js";

export class OpenCodeAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "opencode",
      bin: options.bin || process.env.OPENCODE_BIN || "opencode",
    });
  }
}
