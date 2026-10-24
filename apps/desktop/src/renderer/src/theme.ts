/**
 * Applies desktop preferences to the page: light or dark (the system's
 * unless overridden), glass blur and opacity, accent, and the OS's reduced
 * transparency setting.
 */

import { useSyncExternalStore } from "react";
import type { Prefs } from "./types";

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const transparencyQuery = matchMedia("(prefers-reduced-transparency: reduce)");

export type Mode = "dark" | "light";

let override: Mode | null = null;
const listeners = new Set<() => void>();

const currentMode = (): Mode => override ?? (darkQuery.matches ? "dark" : "light");

function syncMode(): void {
  const root = document.documentElement;
  root.dataset.mode = currentMode();
  root.dataset.transparency = transparencyQuery.matches ? "reduced" : "full";
  for (const listener of listeners) listener();
}
darkQuery.addEventListener("change", syncMode);
transparencyQuery.addEventListener("change", syncMode);
syncMode();

let appliedMode: Prefs["mode"] | null = null;

export function applyPrefs(prefs: Prefs): void {
  const style = document.documentElement.style;
  style.setProperty("--glass-blur", `${prefs.glassBlur}px`);
  style.setProperty("--glass-opacity", String(prefs.glassOpacity / 100));
  if (prefs.accent) style.setProperty("--accent", prefs.accent);
  else style.removeProperty("--accent");
  if (prefs.mode !== appliedMode) {
    appliedMode = prefs.mode;
    override = prefs.mode === "system" ? null : prefs.mode;
    syncMode();
    // The native theme tints the window's caption buttons and background.
    void window.kumo.app.setTheme(prefs.mode).then(syncMode, syncMode);
  }
}

export function useResolvedMode(): Mode {
  return useSyncExternalStore((onChange) => {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  }, currentMode);
}
