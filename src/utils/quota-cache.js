/**
 * quota-cache.js — Ultra-fast disk cache for quota metrics.
 * Allows Kumo to render its startup menu in <5ms without waiting
 * for network/CLI round-trips.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CACHE_FILE = path.join(os.homedir(), ".kumo", "quota_cache.json");

export const QUOTA_TTL_MS = 5 * 60 * 1000;

export function getCachedQuotas() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : null;
      const stale = !updatedAt || Date.now() - updatedAt > QUOTA_TTL_MS;
      return { codex: data.codex ?? null, agy: data.agy ?? null, updatedAt, stale };
    }
  } catch {
    /* ignore read errors */
  }

  // Defaults when no cache exists
  return { codex: null, agy: null, updatedAt: null, stale: true };
}

export function saveCachedQuotas(codexLimits, agyUsage) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let old = {};
    try {
      if (fs.existsSync(CACHE_FILE)) {
        old = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      }
    } catch {
      old = {};
    }
    const next = {
      codex: codexLimits ?? old.codex ?? null,
      agy: agyUsage ?? old.agy ?? null,
      updatedAt: codexLimits || agyUsage ? Date.now() : old.updatedAt || Date.now(),
    };
    const tmp = `${CACHE_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    /* ignore write errors */
  }
}
