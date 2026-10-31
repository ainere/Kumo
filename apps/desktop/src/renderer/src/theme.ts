/**
 * Applies desktop preferences to the page: light or dark (the system's
 * unless overridden), the accent and each mode's own colors, glass blur and
 * opacity, and reduced transparency and motion (the OS settings or the app's
 * own; the OS always counts).
 *
 * Everything lands on :root, so any change (a color picker being dragged
 * included) shows across the window at once:
 *   data-mode="dark|light", data-transparency="full|reduced", data-motion="full|reduced"
 *   --accent, --on-accent, --glass-blur, --glass-opacity, and per mode
 *   --bg, --text, --muted, --faint, --glass-rgb, --glass-strong-rgb.
 * An unset color is removed, so tokens.css shows through. A theme package sits
 * between the two: the user's own colors win over it, and it wins over the app's.
 */

import { useSyncExternalStore } from "react";
import type { Prefs, UserTheme } from "./types";

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const transparencyQuery = matchMedia("(prefers-reduced-transparency: reduce)");
const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");

export type Mode = "dark" | "light";
/** The colors each mode can override (prefs.colors[mode]). */
export type PaletteKey = "ground" | "text" | "muted" | "glass";
export type Palette = Record<PaletteKey, string>;

/** What the page shows now, for what draws outside CSS: the scene and the gallery thumbnails. */
export interface AppliedTheme {
  mode: Mode;
  /** The effective accent as a CSS color (the pref, else the mode's own). */
  accent: string;
  /** The OS or the app asks for reduced motion. */
  reducedMotion: boolean;
  reducedTransparency: boolean;
  /** The OS settings alone, for "on in your system settings" hints. */
  osReducedMotion: boolean;
  osReducedTransparency: boolean;
}

let prefs: Prefs | null = null;
let userTheme: UserTheme | null = null;
let override: Mode | null = null;
let appliedMode: Prefs["mode"] | null = null;
let applied: AppliedTheme | null = null;
const listeners = new Set<() => void>();

const currentMode = (): Mode => override ?? (darkQuery.matches ? "dark" : "light");

const setVar = (style: CSSStyleDeclaration, name: string, value: string | null | undefined): void => {
  if (value) style.setProperty(name, value);
  else style.removeProperty(name);
};

function applyColors(style: CSSStyleDeclaration, colors: Partial<Palette> | undefined): void {
  setVar(style, "--bg", colors?.ground);
  setVar(style, "--text", colors?.text);
  setVar(style, "--muted", colors?.muted);
  // The theme's faint text is its muted color at about two-thirds the strength.
  setVar(style, "--faint", colors?.muted && `color-mix(in srgb, ${colors.muted} 68%, transparent)`);
  const glass = colors?.glass ? hexToTriplet(colors.glass) : null;
  setVar(style, "--glass-rgb", glass);
  setVar(style, "--glass-strong-rgb", glass);
}

function sync(): void {
  const root = document.documentElement;
  const mode = currentMode();
  root.dataset.mode = mode;
  const reducedTransparency = transparencyQuery.matches || prefs?.reduceTransparency === true;
  root.dataset.transparency = reducedTransparency ? "reduced" : "full";
  // The OS setting is handled in CSS with media queries; this is the app's own.
  root.dataset.motion = prefs?.reduceMotion ? "reduced" : "full";
  applyColors(root.style, { ...userTheme?.[mode], ...prefs?.colors[mode] });
  const accent = prefs?.accent ?? userTheme?.[mode].accent ?? null;
  setVar(root.style, "--accent", accent);
  // Text on the accent (the primary button, the selected card's check): whichever of ink or white reads better.
  setVar(root.style, "--on-accent", accent && (contrastRatio(accent, "#ffffff") >= contrastRatio(accent, INK) ? "#ffffff" : INK));

  const next: AppliedTheme = {
    mode,
    // Read back after the attributes and variables above, so it's the mode's own accent when none is set.
    accent: getComputedStyle(root).getPropertyValue("--accent").trim(),
    reducedMotion: motionQuery.matches || prefs?.reduceMotion === true,
    reducedTransparency,
    osReducedMotion: motionQuery.matches,
    osReducedTransparency: transparencyQuery.matches,
  };
  const same = applied && (Object.keys(next) as Array<keyof AppliedTheme>).every((k) => applied?.[k] === next[k]);
  if (!same) applied = next;
  for (const listener of listeners) listener();
}
darkQuery.addEventListener("change", sync);
transparencyQuery.addEventListener("change", sync);
motionQuery.addEventListener("change", sync);
sync();

export function applyPrefs(next: Prefs): void {
  prefs = next;
  const style = document.documentElement.style;
  style.setProperty("--glass-blur", `${next.glassBlur}px`);
  style.setProperty("--glass-opacity", String(next.glassOpacity / 100));
  if (next.mode !== appliedMode) {
    appliedMode = next.mode;
    override = next.mode === "system" ? null : next.mode;
    sync();
    // The native theme tints the window's caption buttons and background.
    void window.kumo.app.setTheme(next.mode).then(sync, sync);
    return;
  }
  sync();
}

// After the app's own stylesheets, so a theme's rules win a tie with them.
const themeStyle = document.head.appendChild(document.createElement("style"));
themeStyle.dataset.kumoTheme = "";

// Whatever in a stylesheet loads a file. On Windows, a url() naming another
// machine has the app try to sign in there, handing over a hash of the login.
const LOADS_A_FILE = /\b(?:url|src)\(\s*["']?(?!data:)|image-set\(\s*["'](?!data:)/i;

/** A theme's rules, minus any that load a file. Parsed first, so no escape or comment hides one. */
function localCss(css: string): string {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return [...sheet.cssRules]
    .map((rule) => rule.cssText)
    .filter((text) => !LOADS_A_FILE.test(text))
    .join("\n");
}

/**
 * Put a theme package on, or take it off with null. `liftCss` keeps its colors
 * but not its stylesheet: no CSS rule can hold out against another stylesheet
 * in the same page, so an approval is only trustworthy with none there.
 */
export function applyUserTheme(next: UserTheme | null, liftCss = false): void {
  userTheme = next;
  themeStyle.textContent = next && !liftCss ? localCss(next.css) : "";
  sync();
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

export function useResolvedMode(): Mode {
  return useSyncExternalStore(subscribe, currentMode);
}

/** The applied mode, accent and reduced motion/transparency; a new object only when one of them changes. */
export function useAppliedTheme(): AppliedTheme {
  return useSyncExternalStore(subscribe, () => applied as AppliedTheme);
}

// ── theme defaults ──

/** The ink used on light accents: the dark ground, a touch bluer. */
const INK = "#04121a";

const defaults = new Map<Mode, Palette & { accent: string }>();

/**
 * The theme's own colors for a mode (tokens.css), whatever is overridden now,
 * as #rrggbb. Muted text is translucent in the theme; it's given as it looks
 * on the ground, since a color picker can't hold alpha.
 */
export function themeDefaults(mode: Mode): Palette & { accent: string } {
  const hit = defaults.get(mode);
  if (hit) return hit;
  // A probe carrying its own data-mode gets that mode's tokens from the
  // stylesheet, not the overrides inlined on :root.
  const probe = document.createElement("div");
  probe.dataset.mode = mode;
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const token = (name: string) => style.getPropertyValue(name).trim();
  const rgba = (css: string): [number, number, number, number] => {
    probe.style.color = "";
    probe.style.color = css;
    return parseRgb(getComputedStyle(probe).color) ?? [0, 0, 0, 1];
  };
  const ground = rgba(token("--bg"));
  const muted = rgba(token("--muted"));
  const over = (c: [number, number, number, number]) =>
    rgbToHex(c[0] * c[3] + ground[0] * (1 - c[3]), c[1] * c[3] + ground[1] * (1 - c[3]), c[2] * c[3] + ground[2] * (1 - c[3]));
  const glass = token("--glass-rgb").split(/[\s,]+/).map(Number);
  const result = {
    accent: over(rgba(token("--accent"))),
    ground: over(ground),
    text: over(rgba(token("--text"))),
    muted: over(muted),
    glass: glass.length === 3 && glass.every(Number.isFinite) ? rgbToHex(glass[0], glass[1], glass[2]) : over(ground),
  };
  probe.remove();
  // Before the stylesheet loads every token is empty: don't keep that.
  if (token("--bg") || result.ground !== "#000000") defaults.set(mode, result);
  return result;
}

// ── color math ──

const HEX6 = /^#[0-9a-f]{6}$/i;

/** "#5FD4F4", "5fd4f4", "#5df", "5DF" → "#5fd4f4"; anything else → null. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#?/, "#");
  if (HEX6.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  return null;
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** "#0c1220" → "12 18 32", for rgb(var(--glass-rgb) / a). */
export function hexToTriplet(hex: string): string {
  return hexToRgb(hex).join(" ");
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)", "rgb(1 2 3 / 0.5)" → [r, g, b, a]. */
function parseRgb(css: string): [number, number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(css.trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
