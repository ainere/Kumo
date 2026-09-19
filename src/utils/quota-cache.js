/**
 * quota-cache.js — Ultra-fast disk cache for quota metrics.
 * Allows Kumo to render its startup menu in <5ms without waiting
 * for network/CLI round-trips.
 */

import fs from "node:fs";
import path from "node:path";
import { kumoHome, atomicWriteJson } from "../config/paths.js";

function cacheFile() {
  return path.join(kumoHome(), "quota_cache.json");
}

export const QUOTA_TTL_MS = 5 * 60 * 1000;

export function getCachedQuotas() {
  try {
    const file = cacheFile();
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : null;
      const now = Date.now();
      // `now < updatedAt` catches a backwards clock step, which would otherwise
      // produce a negative age and pin the cache as fresh forever.
      const stale = !updatedAt || now < updatedAt || now - updatedAt > QUOTA_TTL_MS;
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
    const file = cacheFile();
    let old = {};
    try {
      if (fs.existsSync(file)) {
        old = JSON.parse(fs.readFileSync(file, "utf-8"));
      }
    } catch {
      old = {};
    }
    const next = {
      codex: codexLimits ?? old.codex ?? null,
      agy: agyUsage ?? old.agy ?? null,
      updatedAt: codexLimits || agyUsage ? Date.now() : old.updatedAt || Date.now(),
    };
    atomicWriteJson(file, next);
  } catch {
    /* ignore write errors */
  }
}
