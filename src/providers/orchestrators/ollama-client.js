/**
 * ollama-client.js — Orchestrator client adapter for Ollama local runner (`ollama`).
 */

import { GenericAppClient } from "./generic-client.js";

export class OllamaAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "ollama",
      bin: options.bin || process.env.OLLAMA_BIN || "ollama",
    });
  }

  buildTurn(prompt, { model } = {}) {
    // ollama run takes no --effort flag; effort stays a no-op.
    return { args: ["run", model || "llama3.1", prompt] };
  }
}
