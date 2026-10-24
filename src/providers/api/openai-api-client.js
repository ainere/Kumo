/**
 * openai-api-client.js — Orchestrator client adapter for direct OpenAI API usage.
 * Also serves `compat-api` (OpenAI-compatible endpoints) via the `provider` option.
 *
 * Matches the GenericAppClient surface: constructor/start/startThread/startTurn/
 * interruptTurn/getRateLimits/stop. Single-shot text: emits `delta` with the full
 * text then `turn_completed`, resolving `{ ok: true, text }`.
 */

import { EventEmitter } from "node:events";
import { chatComplete } from "./api-transport.js";

export class OpenAIApiClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.provider = options.provider || "openai-api";
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
    const turn = (this._turnSeq = (this._turnSeq || 0) + 1);
    this.isTurnActive = true;
    try {
      const { text } = await chatComplete({
        provider: this.provider,
        model: turnModel,
        prompt,
        effort: turnEffort,
        config: this.config,
      });
      // Interrupted, or superseded by a newer turn, while the request was in
      // flight: that turn is already closed, and this answer must not complete
      // (and be saved as) the next one.
      if (turn !== this._turnSeq) return { ok: false, stale: true };
      this.isTurnActive = false;
      this.emit("delta", text);
      this.emit("turn_completed", { ok: true });
      return { ok: true, text };
    } catch (err) {
      if (turn !== this._turnSeq) return { ok: false, stale: true };
      this.isTurnActive = false;
      throw err;
    }
  }

  async interruptTurn() {
    // The request cannot be cancelled mid-flight; close the turn now and let
    // startTurn discard the answer when it arrives.
    this._turnSeq = (this._turnSeq || 0) + 1;
    this.isTurnActive = false;
    this.emit("turn_completed", { ok: false, reason: "interrupted" });
  }

  async getRateLimits() {
    return null;
  }

  async stop() {
    this.isTurnActive = false;
  }
}
