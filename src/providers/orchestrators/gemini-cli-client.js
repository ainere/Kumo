/**
 * gemini-cli-client.js — Orchestrator client adapter for the standalone
 * Gemini CLI (`gemini`), distinct from the `agy` binary used by Antigravity.
 */

import { GenericAppClient } from "./generic-client.js";

export class GeminiCliAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "gemini-cli",
      bin: options.bin || process.env.GEMINI_BIN || "gemini",
    });
  }

  buildTurn(prompt, { model } = {}) {
    // gemini CLI takes no --effort flag; effort stays a no-op.
    const args = ["-p", prompt];
    if (model) {
      args.push("-m", model);
    }
    return { args };
  }
}
