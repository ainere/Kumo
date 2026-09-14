/**
 * anthropic-api-client.js — Orchestrator client adapter for direct Anthropic API usage.
 *
 * Matches the GenericAppClient surface: constructor/start/startThread/startTurn/
 * interruptTurn/getRateLimits/stop. Single-shot text: emits `delta` with the full
 * text then `turn_completed`, resolving `{ ok: true, text }`.
 */

import { EventEmitter } from "node:events";
import { chatComplete } from "./api-transport.js";

export class AnthropicApiClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.provider = "anthropic-api";
    this.activeModel = options.model || null;
    this.activeEffort = options.effort || null;
    this.workspace = options.workspace || process.cwd();
    this.env = options.env || {};
    this.config = options.config || {};
    this.isTurnActive = false;
  }

  async start() {
    return Promise.resolve();
  }

  async startThread({ workspace, model, reasoningEffort } = {}) {
    if (workspace) this.workspace = workspace;
    if (model) this.activeModel = model;
    if (reasoningEffort) this.activeEffort = reasoningEffort;
    return { ok: true };
  }

  async startTurn(prompt, { model, effort } = {}) {
    const turnModel = model || this.activeModel;
    const turnEffort = effort || this.activeEffort;
    this.isTurnActive = true;
    try {
      const { text } = await chatComplete({
        provider: this.provider,
        model: turnModel,
        prompt,
        effort: turnEffort,
        config: this.config,
      });
      this.isTurnActive = false;
      this.emit("delta", text);
      this.emit("turn_completed");
      return { ok: true, text };
    } catch (err) {
      this.isTurnActive = false;
      throw err;
    }
  }

  async interruptTurn() {
    this.isTurnActive = false;
    this.emit("turn_completed");
  }

  async getRateLimits() {
    return null;
  }

  async stop() {
    this.isTurnActive = false;
  }
}
