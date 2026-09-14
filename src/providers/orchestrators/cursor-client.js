/**
 * cursor-client.js — Orchestrator client adapter for Cursor Agent CLI (`cursor-agent`).
 */

import { GenericAppClient } from "./generic-client.js";

export class CursorAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "cursor",
      bin: options.bin || process.env.CURSOR_BIN || "cursor-agent",
    });
  }
}
