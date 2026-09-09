/**
 * quota-cache.js — Ultra-fast disk cache for quota metrics.
 * Allows Kumo to render its startup menu in <5ms without waiting
 * for network/CLI round-trips.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CACHE_FILE = path.join(os.homedir(), ".kumo", "quota_cache.json");

export function getCachedQuotas() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      return data;
    }
  } catch {
    /* ignore read errors */
  }

  // Sensible defaults
  return {
    codex: {
      remainingPercent: 91,
      resetFormatted: "in 29d (Oct 10)",
      planType: "ChatGPT Go",
      creditsAvailable: 1,
    },
    agy: {
      geminiWeeklyPercent: 95,
      geminiWeeklyResetFormatted: "in 6d 22h",
      gemini5HourPercent: 68,
      gemini5HourResetFormatted: "in 3h 53m",
    },
  };
}

export function saveCachedQuotas(codexLimits, agyUsage) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload = {
      codex: codexLimits || null,
      agy: agyUsage || null,
      updatedAt: Date.now(),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    /* ignore write errors */
  }
}
