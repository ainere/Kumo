/**
 * ollama-client.js — Lead client for a local Ollama server.
 *
 * Talks to Ollama's OpenAI-compatible API (`/v1/chat/completions`, at
 * OLLAMA_HOST) rather than driving `ollama run`, which has no way to call the
 * worker tools. The loop lives in api-lead.js. The model must support tool
 * calling; Ollama says so when it does not.
 */

import { ApiLeadClient } from "../api/api-lead.js";

export class OllamaAppClient extends ApiLeadClient {
  defaultModel = "llama3.1";

  constructor(options = {}) {
    super({ ...options, provider: "ollama" });
  }
}
