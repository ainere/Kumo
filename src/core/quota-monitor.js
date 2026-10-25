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
 * turn. A running session also polls every signed-in CLI (start(), every
 * `pollMs`): Codex through an app-server of its own, Claude through Claude
 * Code's local `/usage`, and Antigravity through `agy -p /usage` when a role
 * uses it. A poll still running when the next one is due is shared, not
 * doubled. `refresh()` (after a turn) reads only the lead, and Antigravity at
 * most every `antigravityRefreshMs`.
 *
 * Every event carries every account's figures (snapshotAll): Settings ›
 * Accounts shows them all, and the sidebar keeps the providers the crew
 * draws on. The CLI header reads snapshot(), the crew's alone.
 */

import { EventEmitter } from "node:events";
import { getAgyUsage } from "../bridge/agy-runner.js";
import { activeProviders } from "../config/roles.js";
import { getCachedQuotas, saveProviderQuotas } from "../utils/quota-cache.js";
import { accountStatus, cachedAccountStatus, getClaudeUsage, onSignedOut } from "./accounts.js";

/** @typedef {Record<string, unknown> | null} Limits */
/**
 * `providers` holds the account limits of every active provider other than
 * Antigravity (whose usage is `antigravity`): the orchestrator's live ones and
 * the last cached ones for providers that only roles run on.
 *
 * @typedef {{ orchestrator: Limits, antigravity: Limits, providers: Record<string, Limits> }} QuotaSnapshot
 */

/**
 * What one fetch learned, to be saved: limits by provider, and whether the
 * Antigravity usage is new.
 *
 * @typedef {{ limits: Record<string, NonNullable<Limits>>, agy: boolean }} Fresh
 */

export const ORCHESTRATOR_REFRESH_MS = 60 * 1000;
export const ANTIGRAVITY_REFRESH_MS = 5 * 60 * 1000;
/**
 * How often start() probes every signed-in CLI (Antigravity `/usage`, Codex
 * limits, the lead's limits). Sessions pass the `quotaPollMs` config instead.
 */
export const POLL_MS = 10 * 1000;
/** However slow its parts are, a full probe is answered by then, and what it still runs is stopped. */
export const PROBE_TIMEOUT_MS = 20 * 1000;

export class QuotaMonitor extends EventEmitter {
  /**
   * @param {{
   *   getClient: () => any,
   *   getSettings: () => { orchestratorProvider: string, workerProvider: string, [key: string]: any },
   *   fetchAntigravityUsage?: () => Promise<Limits>,
   *   fetchClaudeUsage?: () => Promise<Limits>,
   *   orchestratorRefreshMs?: number,
   *   antigravityRefreshMs?: number,
   *   probeTimeoutMs?: number,
   *   pollMs?: number,
   *   useCache?: boolean,
   * }} opts
   */
  constructor(opts) {
    super();
    this.getClient = opts.getClient;
    this.getSettings = opts.getSettings;
    this.fetchAntigravityUsage = opts.fetchAntigravityUsage || (() => getAgyUsage());
    this.fetchClaudeUsage = opts.fetchClaudeUsage || (() => getClaudeUsage());
    this.orchestratorRefreshMs = opts.orchestratorRefreshMs ?? ORCHESTRATOR_REFRESH_MS;
    this.antigravityRefreshMs = opts.antigravityRefreshMs ?? ANTIGRAVITY_REFRESH_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.pollMs = opts.pollMs ?? POLL_MS;
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
    /** @type {Promise<QuotaSnapshot>|null} the full probe in progress, shared by everyone who asks meanwhile */
    this._probing = null;
    /** @type {AbortController|null} */
    this._probeAbort = null;
    /** @type {Record<string, number>} counts how often a provider's figures were forgotten; a read begun before the last count is stale */
    this._forgotten = {};
    /** @type {(() => void)|null} */
    this._unwatchSignOut = null;
    this._watchSignOut();
    if (this.useCache) this._loadCache();
  }

  /** Drop a provider's figures when its account is signed out through Settings. */
  _watchSignOut() {
    if (!this._unwatchSignOut) this._unwatchSignOut = onSignedOut((provider) => this.forgetProvider(provider));
  }

  /**
   * A signed-out account's figures are not the next account's: forget them,
   * and make any read of them that is still in flight count for nothing.
   *
   * @param {string} provider
   */
  forgetProvider(provider) {
    this._forgotten[provider] = (this._forgotten[provider] ?? 0) + 1;
    delete this.known[provider];
    if (provider === this.getSettings().orchestratorProvider) this.orchestrator = null;
    if (provider === "antigravity") this.antigravity = null;
    this.emit("updated", this.snapshotAll());
  }

  _loadCache() {
    const cached = getCachedQuotas();
    const provider = this.getSettings().orchestratorProvider;
    this.known = { ...(/** @type {Record<string, Limits>} */ (cached.orchestrators || {})) };
    this.orchestrator = this.known[provider] ?? null;
    this.antigravity = /** @type {Limits} */ (cached.agy ?? null);
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
   * Quota figures across all known subscriptions, regardless of active roles.
   * Used on boot and by Settings › Accounts.
   *
   * @returns {QuotaSnapshot}
   */
  snapshotAll() {
    const settings = this.getSettings();
    /** @type {Record<string, Limits>} */
    const providers = {};
    for (const [provider, limits] of Object.entries(this.known)) {
      if (provider === "antigravity" || !limits) continue;
      providers[provider] = limits;
    }
    if (this.orchestrator) {
      providers[settings.orchestratorProvider] = this.orchestrator;
    }
    return { orchestrator: this.orchestrator, antigravity: this.antigravity, providers };
  }

  /**
   * Fetch fresh usage and rate limits for all installed and logged in subscriptions.
   *
   * One probe runs at a time: a caller that asks while one is in progress gets
   * that one's answer. It is bounded by `probeTimeoutMs`; what is still running
   * then (a Codex app-server) is stopped and its late results are dropped.
   *
   * @returns {Promise<QuotaSnapshot>}
   */
  probeAll() {
    if (this._probing) return this._probing;
    const probing = this._probeAll().finally(() => {
      if (this._probing === probing) this._probing = null;
    });
    this._probing = probing;
    return probing;
  }

  /** @returns {Promise<QuotaSnapshot>} */
  async _probeAll() {
    const abort = new AbortController();
    this._probeAbort = abort;
    const { signal } = abort;
    const timer = setTimeout(() => abort.abort(), this.probeTimeoutMs);
    /** @type {Fresh} */
    const fresh = { limits: {}, agy: false };
    const forgottenAtStart = { ...this._forgotten };
    const work = Promise.all([
      this._probeLead(fresh, signal),
      this._probeAntigravity(fresh, signal),
      this._probeCodex(fresh, signal),
      this._probeClaude(fresh, signal),
    ]);
    // A step that fails after the cap has already answered has nobody left to tell.
    work.catch(() => {});
    const expired = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    try {
      await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      if (this._probeAbort === abort) this._probeAbort = null;
    }

    // A provider signed out while this ran keeps nothing this probe read for it, in memory or in the cache.
    for (const provider of Object.keys(fresh.limits)) {
      if ((this._forgotten[provider] ?? 0) === (forgottenAtStart[provider] ?? 0)) continue;
      delete fresh.limits[provider];
      delete this.known[provider];
      if (provider === this.getSettings().orchestratorProvider) this.orchestrator = null;
    }
    if (fresh.agy && (this._forgotten.antigravity ?? 0) !== (forgottenAtStart.antigravity ?? 0)) {
      fresh.agy = false;
      this.antigravity = null;
    }
    this._persist(fresh);
    const snap = this.snapshotAll();
    this.emit("updated", snap);
    return snap;
  }

  /**
   * 1. The active orchestrator's client.
   *
   * @param {Fresh} fresh
   * @param {AbortSignal} signal
   */
  async _probeLead(fresh, signal) {
    const lead = await this._readLead();
    if (!lead || signal.aborted) return;
    this.orchestrator = lead.limits;
    this.known[lead.provider] = lead.limits;
    fresh.limits[lead.provider] = lead.limits;
  }

  /**
   * 2. Antigravity (`/usage`): only when a role runs on it (see the file
   * header), and not when the accounts check just found it signed out.
   *
   * @param {Fresh} fresh
   * @param {AbortSignal} signal
   */
  async _probeAntigravity(fresh, signal) {
    if (!this.usesAntigravity() || !this._accountUsable(cachedAccountStatus("antigravity"))) return;
    try {
      const agy = await this.fetchAntigravityUsage().catch(() => null);
      if (agy && !signal.aborted) {
        this.antigravity = agy;
        fresh.agy = true;
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * 3. Codex's limits through an app-server of its own, when Codex is not the
   * orchestrator (whose client reports them) and its account is usable. The
   * app-server is stopped however this ends, including when the probe's time
   * is up.
   *
   * @param {Fresh} fresh
   * @param {AbortSignal} signal
   */
  async _probeCodex(fresh, signal) {
    if (this.getSettings().orchestratorProvider === "codex") return;
    if (!this._accountUsable(await accountStatus("codex")) || signal.aborted) return;
    try {
      const { CodexAppClient } = await import("../providers/orchestrators/codex-client.js");
      // No await between this check and start(): the client exists only while the abort can reach it.
      if (signal.aborted) return;
      const codexClient = new CodexAppClient();
      const stopClient = () => void codexClient.stop().catch(() => {});
      signal.addEventListener("abort", stopClient, { once: true });
      const forgotten = this._forgotten["codex"] ?? 0;
      try {
        await codexClient.start();
        const limits = await codexClient.getRateLimits();
        if (limits && !signal.aborted && (this._forgotten["codex"] ?? 0) === forgotten) {
          this.known["codex"] = limits;
          fresh.limits["codex"] = limits;
        }
      } finally {
        signal.removeEventListener("abort", stopClient);
        await codexClient.stop().catch(() => {});
      }
    } catch {
      /* ignore if codex app-server cannot be queried */
    }
  }

  /**
   * 4. Claude's plan usage through Claude Code's local `/usage` (no model
   * call), whether or not Claude leads: the lead's own figures arrive only
   * with a turn's rate-limit event.
   *
   * @param {Fresh} fresh
   * @param {AbortSignal} signal
   */
  async _probeClaude(fresh, signal) {
    if (!this._accountUsable(await accountStatus("claude")) || signal.aborted) return;
    const forgotten = this._forgotten["claude"] ?? 0;
    const limits = await this.fetchClaudeUsage().catch(() => null);
    if (!limits || signal.aborted || (this._forgotten["claude"] ?? 0) !== forgotten) return;
    this.known["claude"] = limits;
    fresh.limits["claude"] = limits;
    if (this.getSettings().orchestratorProvider === "claude") this.orchestrator = limits;
  }

  /**
   * Whether an account may be asked for its limits: unless the accounts check
   * found it signed out or not installed. No reading (null) or one that could
   * not tell (`signedIn` null) does not rule it out.
   *
   * @param {{ signedIn: boolean | null } | null} status
   */
  _accountUsable(status) {
    return status === null || status.signedIn !== false;
  }

  /**
   * The orchestrator's live limits, with the provider they belong to. Null
   * when there are none, or when the lead was switched (or signed out) while
   * the client was being asked: a result for the old client must not be filed
   * under the new provider.
   *
   * @returns {Promise<{ provider: string, limits: NonNullable<Limits> } | null>}
   */
  async _readLead() {
    const provider = this.getSettings().orchestratorProvider;
    const client = this.getClient();
    if (!client || typeof client.getRateLimits !== "function") return null;
    const forgotten = this._forgotten[provider] ?? 0;
    const limits = await client.getRateLimits().catch(() => null);
    if (!limits || this.getSettings().orchestratorProvider !== provider || (this._forgotten[provider] ?? 0) !== forgotten) return null;
    return { provider, limits };
  }

  /**
   * Save what a fetch just learned, each under its own provider.
   *
   * @param {Fresh} fresh
   */
  _persist(fresh) {
    if (!this.useCache) return;
    const agy = fresh.agy ? this.antigravity : null;
    const entries = Object.entries(fresh.limits);
    if (entries.length === 0 && agy) saveProviderQuotas(this.getSettings().orchestratorProvider, null, agy);
    for (const [provider, limits] of entries) saveProviderQuotas(provider, limits, agy);
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
    /** @type {Fresh} */
    const fresh = { limits: {}, agy: false };
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
    const lead = await this._readLead();
    if (lead) {
      this.orchestrator = lead.limits;
      this.known[lead.provider] = lead.limits;
      fresh.limits[lead.provider] = lead.limits;
      changed = true;
    }
    const now = Date.now();
    if (this.usesAntigravity() && (force || now - this._antigravityAt >= this.antigravityRefreshMs)) {
      this._antigravityAt = now;
      const usage = await this.fetchAntigravityUsage().catch(() => null);
      if (usage) {
        this.antigravity = usage;
        fresh.agy = true;
        changed = true;
      }
    }
    if (changed) {
      this._persist(fresh);
      this.emit("updated", this.snapshotAll());
    }
    return this.snapshot();
  }

  /**
   * Probe every signed-in CLI every `pollMs` (10 s by default) until stop().
   * A probe still running when the next tick comes is shared, not doubled
   * (see probeAll).
   */
  start() {
    if (this._timer) return;
    this._watchSignOut();
    this._timer = setInterval(() => void this.probeAll().catch(() => {}), this.pollMs);
    this._timer.unref();
  }

  /** Stop refreshing, stop what a probe in progress still runs, and stop listening for sign-outs. */
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._probeAbort?.abort();
    this._unwatchSignOut?.();
    this._unwatchSignOut = null;
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
    this.emit("updated", this.snapshotAll());
  }
}
