/**
 * copilot-client.js — Orchestrator client adapter for GitHub Copilot CLI (`gh copilot`).
 */

import { GenericAppClient } from "./generic-client.js";

export class CopilotAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "copilot",
      bin: options.bin || process.env.COPILOT_BIN || "gh",
    });
  }

  buildTurn(prompt, { model } = {}) {
    // gh copilot has no --effort flag; effort stays a no-op.
    const args = ["copilot", "-p", prompt];
    if (model) {
      args.push("--model", model);
    }
    return { args };
  }
}
