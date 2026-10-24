// @ts-check
/**
 * quota-monitor.js — The quota figures a session shows, refreshed at a cost
 * that matches where they come from.
 *
 * The orchestrator's limits come from its client: a JSON-RPC call on Codex's
 * running app-server, or the rate-limit event Claude Code reports with every
 * turn — both free. Antigravity's come from spawning `agy -p /usage`, which
 * takes seconds; that runs only when a role actually uses Antigravity, and at
 * most every five minutes. It used to run every 30 seconds and after every
 * turn whether Antigravity was configured or not.
 */

import { EventEmitter } from "node:events";
import { getAgyUsage } from "../bridge/agy-runner.js";
import { getCachedQuotas, saveProviderQuotas } from "../utils/quota-cache.js";

/** @typedef {Record<string, unknown> | null} Limits */
/** @typedef {{ orchestrator: Limits, antigravity: Limits }} QuotaSnapshot */

export const ORCHESTRATOR_REFRESH_MS = 60 * 1000;
export const ANTIGRAVITY_REFRESH_MS = 5 * 60 * 1000;

export class QuotaMonitor extends EventEmitter {
  /**
   * @param {{
   *   getClient: () => any,
   *   getSettings: () => { orchestratorProvider: string, workerProvider: string },
   *   fetchAntigravityUsage?: () => Promise<Limits>,
   *   orchestratorRefreshMs?: number,
   *   antigravityRefreshMs?: number,
   *   useCache?: boolean,
   * }} opts
   */
  constructor(opts) {
    super();
    this.getClient = opts.getClient;
    this.getSettings = opts.getSettings;
    this.fetchAntigravityUsage = opts.fetchAntigravityUsage || (() => getAgyUsage());
    this.orchestratorRefreshMs = opts.orchestratorRefreshMs ?? ORCHESTRATOR_REFRESH_MS;
    this.antigravityRefreshMs = opts.antigravityRefreshMs ?? ANTIGRAVITY_REFRESH_MS;
    this.useCache = opts.useCache !== false;
    /** @type {Limits} */
    this.orchestrator = null;
    /** @type {Limits} */
    this.antigravity = null;
    this._antigravityAt = 0;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    if (this.useCache) this._loadCache();
  }

  _loadCache() {
    const cached = getCachedQuotas();
    const provider = this.getSettings().orchestratorProvider;
    this.orchestrator = /** @type {Limits} */ (cached.orchestrators?.[provider] ?? null);
    this.antigravity = this.usesAntigravity() ? /** @type {Limits} */ (cached.agy ?? null) : null;
  }

  /** Whether either role runs on Antigravity. */
  usesAntigravity() {
    const s = this.getSettings();
    return s.orchestratorProvider === "antigravity" || s.workerProvider === "antigravity";
  }

  /** @returns {QuotaSnapshot} */
  snapshot() {
    return { orchestrator: this.orchestrator, antigravity: this.usesAntigravity() ? this.antigravity : null };
  }

  /**
   * Fetch what is due. `force` also queries Antigravity when its interval has
   * not passed (an explicit /status or /refresh).
   *
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<QuotaSnapshot>}
   */
  async refresh({ force = false } = {}) {
    let changed = false;
    const client = this.getClient();
    if (client && typeof client.getRateLimits === "function") {
      const limits = await client.getRateLimits().catch(() => null);
      if (limits) {
        this.orchestrator = limits;
        changed = true;
      }
    }
    const now = Date.now();
    if (this.usesAntigravity() && (force || now - this._antigravityAt >= this.antigravityRefreshMs)) {
      this._antigravityAt = now;
      const usage = await this.fetchAntigravityUsage().catch(() => null);
      if (usage) {
        this.antigravity = usage;
        changed = true;
      }
    }
    if (changed) {
      if (this.useCache) saveProviderQuotas(this.getSettings().orchestratorProvider, this.orchestrator, this.antigravity);
      this.emit("updated", this.snapshot());
    }
    return this.snapshot();
  }

  /** Refresh periodically until stop(). */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => void this.refresh(), this.orchestratorRefreshMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** The orchestrator provider changed: its cached limits belong to the old one. */
  providerChanged() {
    if (this.useCache) this._loadCache();
    else this.orchestrator = null;
    this.emit("updated", this.snapshot());
  }
}
