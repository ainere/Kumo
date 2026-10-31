/**
 * The usage rows both views draw (the sidebar's Usage panel and Settings ›
 * Accounts), shaped from one quota snapshot so they always agree.
 */

import { providerLabel } from "./lib";
import type { Limits, Quotas } from "./types";

/** One usage window: the share left (0-100) and when it resets. */
export type MeterWindow = { left: number; reset: string | null };
/**
 * One bar per provider or Antigravity pool, with its 5-hour, weekly and monthly windows layered on the same track.
 * A provider in use with no reading yet has a `note` and no windows.
 */
export type Meter = {
  label: string;
  fiveHour: MeterWindow | null;
  weekly: MeterWindow | null;
  monthly: MeterWindow | null;
  note?: string;
};
export type WindowKey = "fiveHour" | "weekly" | "monthly";

export const WINDOW_KEYS: WindowKey[] = ["fiveHour", "weekly", "monthly"];

const NO_READING = "No reading yet";

/** Antigravity's usage is split by model pool; each pool's fields in its limits start with this prefix. */
const AGY_POOLS = [
  ["Gemini", "gemini"],
  ["Gemini 4 Argon", "geminiArgon"],
  ["Claude/GPT", "claudeGpt"],
] as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v && v !== "N/A" ? v : null);
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
/** "agy" and "antigravity" are one provider. */
const normProvider = (p: string | null | undefined): string => {
  const v = (p ?? "").trim().toLowerCase();
  return v === "agy" ? "antigravity" : v;
};

/** Windows up to 6 hours are the 5-hour limit; up to 8 days are weekly; longer is monthly. */
function windowKey(windowMinutes: unknown, fallback: WindowKey): WindowKey {
  const mins = num(windowMinutes);
  if (!mins) return fallback;
  if (mins <= 360) return "fiveHour";
  if (mins <= 11520) return "weekly";
  return "monthly";
}

/** Two windows that land in the same slot keep the tighter one. */
function place(meter: Meter, key: WindowKey, win: MeterWindow): void {
  const current = meter[key];
  if (!current || win.left < current.left) meter[key] = win;
}

/** An Antigravity window, which already reports the share left. */
function remaining(percent: unknown, reset: unknown): MeterWindow | null {
  const left = num(percent);
  return left === null ? null : { left: clamp(left), reset: str(reset) };
}

/** A provider's account limits, which report the share used, as one bar; null with no reading. */
function limitsMeter(label: string, limits: Limits | undefined): Meter | null {
  const used = num(limits?.usedPercent);
  if (!limits || used === null) return null;
  const meter: Meter = { label, fiveHour: null, weekly: null, monthly: null };
  place(meter, windowKey(limits.windowMinutes, "fiveHour"), {
    left: clamp(100 - used),
    reset: str(limits.resetFormatted),
  });
  const secondary = limits.secondary as Record<string, unknown> | null | undefined;
  const usedLater = num(secondary?.usedPercent);
  if (secondary && usedLater !== null) {
    place(meter, windowKey(secondary.windowMinutes, "weekly"), {
      left: clamp(100 - usedLater),
      reset: str(secondary.resetFormatted),
    });
  }
  return meter;
}

/** Antigravity's pools that have a reading, one bar each. */
function antigravityMeters(limits: Limits | undefined): Meter[] {
  if (!limits) return [];
  const out: Meter[] = [];
  for (const [label, prefix] of AGY_POOLS) {
    const fiveHour = remaining(limits[`${prefix}5HourPercent`], limits[`${prefix}5HourResetFormatted`]);
    const weekly = remaining(limits[`${prefix}WeeklyPercent`], limits[`${prefix}WeeklyResetFormatted`]);
    if (fiveHour || weekly) out.push({ label, fiveHour, weekly, monthly: null });
  }
  return out;
}

/**
 * The bars one provider has a reading for: Antigravity's pools, or the
 * provider's own 5-hour and weekly windows. Empty with no reading. The lead's
 * own limits stand in when the provider's entry is missing; Antigravity's are
 * only its pools, never the lead's.
 */
export function providerMeters(quotas: Quotas, provider: string): Meter[] {
  const id = normProvider(provider);
  if (id === "antigravity") return antigravityMeters(quotas.antigravity);
  const isLead = id === normProvider(quotas.active?.[0]);
  const meter = limitsMeter(providerLabel(id), quotas.providers?.[id] ?? (isLead ? quotas.orchestrator : null));
  return meter ? [meter] : [];
}

/**
 * The bars of every provider in use (the lead, the shared worker, any role),
 * in that order, each with all of its bars. One with no reading yet gets a
 * row with its name and a note instead.
 */
export function usageMeters(quotas: Quotas): Meter[] {
  const out: Meter[] = [];
  const seen = new Set<string>();
  for (const provider of quotas.active ?? []) {
    const id = normProvider(provider);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rows = providerMeters(quotas, id);
    if (rows.length > 0) out.push(...rows);
    else out.push({ label: providerLabel(id), fiveHour: null, weekly: null, monthly: null, note: NO_READING });
  }
  return out;
}
