/**
 * openai-api-client.js — Lead client for direct OpenAI API usage.
 * Also serves `compat-api` (OpenAI-compatible endpoints) via the `provider` option.
 *
 * The loop that offers the bridge's worker tools to the model, runs its calls
 * and keeps the conversation lives in api-lead.js; this only names the provider.
 */

import { ApiLeadClient } from "./api-lead.js";

export class OpenAIApiClient extends ApiLeadClient {
  constructor(options = {}) {
    super({ ...options, provider: options.provider || "openai-api" });
  }
}
