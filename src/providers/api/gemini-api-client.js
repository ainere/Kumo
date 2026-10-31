/**
 * gemini-api-client.js — Lead client for direct Google Gemini API usage.
 *
 * The loop that offers the bridge's worker tools to the model, runs its calls
 * and keeps the conversation lives in api-lead.js; this only names the provider.
 */

import { ApiLeadClient } from "./api-lead.js";

export class GeminiApiClient extends ApiLeadClient {
  constructor(options = {}) {
    super({ ...options, provider: "gemini-api" });
  }
}
