/**
 * quota-cache.js — Ultra-fast disk cache for quota metrics.
 * Allows Kumo to render its startup menu in <5ms without waiting
 * for network/CLI round-trips.
 *
 * Layout: `{ orchestrators: { <provider>: limits }, agy, updatedAt }`, plus
 * the legacy `codex` key (Codex's limits) that older readers expect.
 */

import fs from "node:fs";
import path from "node:path";
import { kumoHome, atomicWriteJson } from "../config/paths.js";

function cacheFile() {
  return path.join(kumoHome(), "quota_cache.json");
}

export const QUOTA_TTL_MS = 5 * 60 * 1000;

function readCache() {
  try {
    const file = cacheFile();
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    /* ignore read errors */
  }
  return {};
}

export function getCachedQuotas() {
  const data = readCache();
  const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : null;
  const now = Date.now();
  // `now < updatedAt` catches a backwards clock step, which would otherwise
  // produce a negative age and pin the cache as fresh forever.
  const stale = !updatedAt || now < updatedAt || now - updatedAt > QUOTA_TTL_MS;
  const orchestrators = data.orchestrators && typeof data.orchestrators === "object" ? data.orchestrators : {};
  const codex = orchestrators.codex ?? data.codex ?? null;
  return { codex, agy: data.agy ?? null, orchestrators: { ...orchestrators, ...(codex ? { codex } : {}) }, updatedAt, stale };
}

/**
 * Save what is known; a null argument keeps the cached value.
 *
 * @param {object|null} codexLimits
 * @param {object|null} agyUsage
 */
export function saveCachedQuotas(codexLimits, agyUsage) {
  saveProviderQuotas("codex", codexLimits, agyUsage);
}

/**
 * Save one orchestrator provider's limits (and Antigravity usage).
 *
 * @param {string} provider
 * @param {object|null} limits
 * @param {object|null} [agyUsage]
 */
export function saveProviderQuotas(provider, limits, agyUsage = null) {
  try {
    const old = readCache();
    const orchestrators = { ...(old.orchestrators || {}) };
    if (old.codex && !orchestrators.codex) orchestrators.codex = old.codex;
    if (limits) orchestrators[provider] = limits;
    const next = {
      orchestrators,
      codex: orchestrators.codex ?? null,
      agy: agyUsage ?? old.agy ?? null,
      updatedAt: limits || agyUsage ? Date.now() : old.updatedAt || Date.now(),
    };
    atomicWriteJson(cacheFile(), next);
  } catch {
    /* ignore write errors */
  }
}

/**
 * Forget one provider's cached limits, after its account was signed out: the
 * next account must not be shown the last one's quota. `antigravity` clears
 * the Antigravity usage. Nothing is written when nothing was cached.
 *
 * @param {string} provider
 */
export function dropProviderQuotas(provider) {
  try {
    const old = readCache();
    const orchestrators = { ...(old.orchestrators || {}) };
    const hadProvider = Object.hasOwn(orchestrators, provider) || (provider === "codex" && old.codex != null);
    const hadAgy = provider === "antigravity" && old.agy != null;
    if (!hadProvider && !hadAgy) return;
    delete orchestrators[provider];
    // The legacy `codex` key is the same limits under the name older readers expect.
    const codex = provider === "codex" ? null : (orchestrators.codex ?? old.codex ?? null);
    const next = { ...old, orchestrators, codex, agy: provider === "antigravity" ? null : (old.agy ?? null) };
    atomicWriteJson(cacheFile(), next);
  } catch {
    /* ignore write errors */
  }
}
