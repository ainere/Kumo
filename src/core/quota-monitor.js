/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

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
 *
 * Every provider the crew draws on is covered, not just the lead's and the
 * shared worker's: a role assigned to Codex or Claude shows that account's
 * last cached limits, and any Antigravity role turns on Antigravity's usage.
 */

import { EventEmitter } from "node:events";
import { getAgyUsage } from "../bridge/agy-runner.js";
import { activeProviders } from "../config/roles.js";
import { getCachedQuotas, saveProviderQuotas } from "../utils/quota-cache.js";

/** @typedef {Record<string, unknown> | null} Limits */
/**
 * `providers` holds the account limits of every active provider other than
 * Antigravity (whose usage is `antigravity`): the orchestrator's live ones and
 * the last cached ones for providers that only roles run on.
 *
 * @typedef {{ orchestrator: Limits, antigravity: Limits, providers: Record<string, Limits> }} QuotaSnapshot
 */

export const ORCHESTRATOR_REFRESH_MS = 60 * 1000;
export const ANTIGRAVITY_REFRESH_MS = 5 * 60 * 1000;

export class QuotaMonitor extends EventEmitter {
  /**
   * @param {{
   *   getClient: () => any,
   *   getSettings: () => { orchestratorProvider: string, workerProvider: string, [key: string]: any },
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
    /** @type {Record<string, Limits>} last known limits per provider (cache, then live) */
    this.known = {};
    this._antigravityAt = 0;
    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    if (this.useCache) this._loadCache();
  }

  _loadCache() {
    const cached = getCachedQuotas();
    const provider = this.getSettings().orchestratorProvider;
    this.known = { ...(/** @type {Record<string, Limits>} */ (cached.orchestrators || {})) };
    this.orchestrator = this.known[provider] ?? null;
    this.antigravity = this.usesAntigravity() ? /** @type {Limits} */ (cached.agy ?? null) : null;
  }

  /** Providers in use by the orchestrator, the shared worker or any role. */
  activeProviders() {
    return activeProviders(this.getSettings());
  }

  /** Whether any role (the lead, the shared worker, a built-in or custom role) runs on Antigravity. */
  usesAntigravity() {
    return this.activeProviders().includes("antigravity");
  }

  /** @returns {QuotaSnapshot} */
  snapshot() {
    const settings = this.getSettings();
    /** @type {Record<string, Limits>} */
    const providers = {};
    for (const provider of this.activeProviders()) {
      if (provider === "antigravity") continue;
      const limits = provider === settings.orchestratorProvider ? this.orchestrator ?? this.known[provider] : this.known[provider];
      if (limits) providers[provider] = limits;
    }
    return { orchestrator: this.orchestrator, antigravity: this.usesAntigravity() ? this.antigravity : null, providers };
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
    // Providers only roles run on report nothing live here; pick up what
    // another session or `kumo status` cached for them since.
    if (this.useCache) {
      const cached = /** @type {Record<string, Limits>} */ (getCachedQuotas().orchestrators || {});
      const orchestratorProvider = this.getSettings().orchestratorProvider;
      for (const [provider, limits] of Object.entries(cached)) {
        if (provider === orchestratorProvider || !limits) continue;
        if (JSON.stringify(this.known[provider]) !== JSON.stringify(limits)) {
          this.known[provider] = limits;
          changed = true;
        }
      }
    }
    const client = this.getClient();
    if (client && typeof client.getRateLimits === "function") {
      const limits = await client.getRateLimits().catch(() => null);
      if (limits) {
        this.orchestrator = limits;
        this.known[this.getSettings().orchestratorProvider] = limits;
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

  /** Active providers changed: reload cached limits for the new set and align the lead's. */
  providerChanged() {
    if (this.useCache) {
      const cached = getCachedQuotas();
      this.known = { ...(/** @type {Record<string, Limits>} */ (cached.orchestrators || {})), ...this.known };
      this.orchestrator = this.known[this.getSettings().orchestratorProvider] ?? null;
      this.antigravity = this.usesAntigravity() ? (this.antigravity ?? /** @type {Limits} */ (cached.agy ?? null)) : null;
    } else {
      this.orchestrator = this.known[this.getSettings().orchestratorProvider] ?? null;
    }
    this.emit("updated", this.snapshot());
  }
}
