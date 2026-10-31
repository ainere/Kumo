/**
 * Settings › Appearance: light or dark, the accent (a preset or any color),
 * the background scene (built in or the user's own files), where the Workers
 * panel docks, and the glass. Everything applies as it changes.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { previewPrefs, savePrefs, toast, toastFailure, useStore } from "../../store";
import { contrastRatio, hexToRgb, normalizeHex, rgbToHex, themeDefaults, useAppliedTheme } from "../../theme";
import type { Prefs, SceneFile } from "../../types";
import { IconCheck, IconChevronDown, IconFolder, IconRefresh } from "../icons";
import { PageHeader, Row, Section, Segmented, Slider, Toggle, useEscape, usePopoverPlacement, useRowLabel } from "./controls";

const save = (patch: Partial<Prefs>) => savePrefs(patch).catch((err) => toastFailure(err));

// ── accent ──

/** Presets beside the theme's own accent. */
const ACCENT_PRESETS = [
  { label: "Cobalt", color: "#3b82f6" },
  { label: "Indigo", color: "#6366f1" },
  { label: "Violet", color: "#a855f7" },
  { label: "Emerald", color: "#10b981" },
  { label: "Amber", color: "#f59e0b" },
  { label: "Rose", color: "#f43f5e" },
] as const;

/** Ink or white, whichever reads better on the color: the check on a swatch. */
const inkOn = (hex: string): string => (contrastRatio(hex, "#ffffff") >= contrastRatio(hex, "#04121a") ? "#ffffff" : "#04121a");

function AccentPicker() {
  const accent = useStore((s) => s.prefs?.accent ?? null);
  const theme = useAppliedTheme();
  const row = useRowLabel();
  const trigger = useRef<HTMLButtonElement>(null);
  const radios = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);

  const own = themeDefaults(theme.mode).accent;
  const current = accent ? normalizeHex(accent) : null;
  const shown = current ?? normalizeHex(theme.accent) ?? own;
  const choices: Array<{ label: string; color: string; value: string | null }> = [
    { label: "Theme accent", color: own, value: null },
    ...ACCENT_PRESETS.map((p) => ({ label: p.label, color: p.color, value: p.color })),
  ];
  const checked = choices.findIndex((c) => c.value === current);
  const custom = current !== null && checked === -1;

  const pick = (i: number) => {
    const choice = choices[i];
    if (choice && choice.value !== current) void save({ accent: choice.value });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, at: number) => {
    const n = choices.length;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (at + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (at - 1 + n) % n
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : -1;
    if (next === -1) return;
    e.preventDefault();
    pick(next);
    radios.current[next]?.focus();
  };

  return (
    <div className="accent-picker" data-part="accent-picker">
      <div className="accent-swatches" role="radiogroup" aria-labelledby={row?.labelId} aria-describedby={row?.hintId}>
        {choices.map((c, i) => (
          <button
            key={c.label}
            ref={(el) => {
              radios.current[i] = el;
            }}
            type="button"
            role="radio"
            className="accent-swatch"
            aria-checked={i === checked}
            aria-label={c.label}
            data-tooltip={c.label}
            data-tooltip-pos="top"
            tabIndex={i === (checked === -1 ? 0 : checked) ? 0 : -1}
            style={{ "--swatch": c.color, "--swatch-ink": inkOn(c.color) } as CSSProperties}
            onClick={() => pick(i)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            <IconCheck />
          </button>
        ))}
      </div>
      <span className="accent-divider" aria-hidden="true" />
      <button
        ref={trigger}
        type="button"
        className="accent-custom"
        data-part="accent-custom"
        data-custom={custom || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Custom color, now ${shown}`}
        style={{ "--swatch": shown } as CSSProperties}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="accent-custom-dot" aria-hidden="true" />
        <span>{shown}</span>
        <IconChevronDown />
      </button>
      {open && <ColorPopover anchor={trigger} start={accent} base={shown} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Hsv = [number, number, number];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function hexToHsv(hex: string): Hsv {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max ? d / max : 0, max];
}

function hsvToHex([h, s, v]: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return rgbToHex(f(5), f(3), f(1));
}

/**
 * Any color: a saturation/brightness plane, a hue strip and the hex. Every
 * change shows across the window at once and saves as it settles; Esc puts
 * back the accent from before it opened, a click outside or Done keeps it.
 */
function ColorPopover({
  anchor,
  start,
  base,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  /** The saved accent when it opened (null: the theme's own). */
  start: string | null;
  /** The color it starts from. */
  base: string;
  onClose: () => void;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const hsv = useRef<Hsv>(hexToHsv(base));
  const [, setVersion] = useState(0);
  const [text, setText] = useState(base);
  const box = usePopoverPlacement(anchor, true, () => 256);
  const hex = hsvToHex(hsv.current);

  const set = (next: Hsv, fromText = false) => {
    hsv.current = next;
    setVersion((n) => n + 1);
    const value = hsvToHex(next);
    if (!fromText) setText(value);
    previewPrefs({ accent: value });
  };

  const close = (refocus: boolean) => {
    onClose();
    if (refocus) anchor.current?.focus({ preventScroll: true });
  };

  // Esc: the accent from before.
  useEscape(true, () => {
    previewPrefs({ accent: start });
    close(true);
  });

  // A press anywhere else keeps the color and closes.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(".color-plane")?.focus({ preventScroll: true });
  }, [box !== null]);

  const drag = (e: ReactPointerEvent<HTMLDivElement>, at: (x: number, y: number, r: DOMRect) => Hsv) => {
    if (e.type === "pointerdown") {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus({ preventScroll: true });
    } else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    set(at(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()));
  };
  const onPlane = (e: ReactPointerEvent<HTMLDivElement>) =>
    drag(e, (x, y, r) => [hsv.current[0], clamp01((x - r.left) / r.width), 1 - clamp01((y - r.top) / r.height)]);
  const onHue = (e: ReactPointerEvent<HTMLDivElement>) =>
    drag(e, (x, _y, r) => [clamp01((x - r.left) / r.width) * 359.9, hsv.current[1], hsv.current[2]]);

  const planeKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const [h, s, v] = hsv.current;
    const next: Hsv | null =
      e.key === "ArrowLeft" ? [h, clamp01(s - step), v]
      : e.key === "ArrowRight" ? [h, clamp01(s + step), v]
      : e.key === "ArrowUp" ? [h, s, clamp01(v + step)]
      : e.key === "ArrowDown" ? [h, s, clamp01(v - step)]
      : null;
    if (!next) return;
    e.preventDefault();
    set(next);
  };
  const hueKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 1;
    const [h, s, v] = hsv.current;
    const next =
      e.key === "ArrowLeft" || e.key === "ArrowDown" ? (h - step + 360) % 360
      : e.key === "ArrowRight" || e.key === "ArrowUp" ? (h + step) % 360
      : e.key === "Home" ? 0
      : e.key === "End" ? 359
      : null;
    if (next === null) return;
    e.preventDefault();
    set([next, s, v]);
  };

  const typed = normalizeHex(text);
  const [h, s, v] = hsv.current;

  if (!box) return null;
  return createPortal(
    <div
      ref={panel}
      className="popover-panel color-popover menu-surface"
      role="dialog"
      aria-label="Custom accent color"
      data-part="color-popover"
      data-placement={box.top !== undefined ? "below" : "above"}
      style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width, "--hue": h.toFixed(1), "--swatch": hex } as CSSProperties}
    >
      <div
        className="color-plane"
        role="slider"
        tabIndex={0}
        aria-roledescription="2D slider"
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(s * 100)}
        aria-valuetext={`Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`}
        onPointerDown={onPlane}
        onPointerMove={onPlane}
        onKeyDown={planeKeys}
      >
        <span className="color-thumb" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
      </div>
      <div
        className="color-hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={359}
        aria-valuenow={Math.round(h)}
        aria-valuetext={`${Math.round(h)}°`}
        onPointerDown={onHue}
        onPointerMove={onHue}
        onKeyDown={hueKeys}
      >
        <span className="color-thumb" style={{ left: `${(h / 360) * 100}%`, "--swatch": `hsl(${h.toFixed(1)} 100% 50%)` } as CSSProperties} />
      </div>
      <div className="color-popover-row">
        <span className="color-preview" aria-hidden="true" />
        <label className="sr-only" htmlFor={`${id}-hex`}>
          Hex color
        </label>
        <input
          id={`${id}-hex`}
          className="field"
          data-mono
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          value={text}
          aria-invalid={typed ? undefined : true}
          onChange={(e) => {
            setText(e.target.value);
            const next = normalizeHex(e.target.value);
            if (next) set(hexToHsv(next), true);
          }}
          onBlur={() => setText(hex)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              close(true);
            }
          }}
        />
      </div>
      <div className="color-popover-foot">
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            previewPrefs({ accent: null });
            close(true);
          }}
        >
          Use theme accent
        </button>
        <button type="button" className="btn sm primary" onClick={() => close(true)}>
          Done
        </button>
      </div>
    </div>,
    document.body
  );
}

// ── scenes ──

type SceneOption = { id: string; name: string; group: "builtin" | "user"; file?: string; error?: string | null };

/** The built-in scenes, for before the scene page has said which it has. */
const BUILT_IN = [
  { id: "clouds", name: "Clouds" },
  { id: "stars", name: "Night sky" },
];

const sceneSub = (o: SceneOption): string =>
  o.error ? "Has an error" : o.group === "user" ? (o.file ?? "Your scene") : o.id === "none" ? "Plain background" : "Built in";

/** A small, stable number from a string: a user scene's hue, and the shape of its poster. */
const hashOf = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

const RAMP = " .:-=+*#%@";
const POSTER_COLS = 40;
const POSTER_ROWS = 12;

/**
 * A scene's poster, in the scenes' own ASCII: a scatter of stars for Night
 * sky, soft clouds for the rest (shaped by the scene's id, so each of the
 * user's files has its own). Not live: one running scene is enough.
 */
function posterOf(id: string): string {
  if (id === "none") return "";
  let seed = hashOf(id);
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const lines: string[] = [];
  if (id === "stars") {
    for (let y = 0; y < POSTER_ROWS; y++) {
      let line = "";
      for (let x = 0; x < POSTER_COLS; x++) {
        const r = rand();
        line += r > 0.988 ? "*" : r > 0.965 ? "+" : r > 0.915 ? "." : " ";
      }
      lines.push(line);
    }
    return lines.join("\n");
  }
  // Clouds gets a drawn sky: a bank across the middle, two wisps above it.
  const blobs =
    id === "clouds"
      ? [
          { x: 9, y: 7, r: 5 },
          { x: 17, y: 6.5, r: 6.5 },
          { x: 25, y: 7.5, r: 5 },
          { x: 31, y: 3, r: 3.5 },
          { x: 13, y: 3.5, r: 2.5 },
        ]
      : // Kept off the edges, which the thumbnail crops.
        Array.from({ length: 3 }, () => ({ x: 10 + rand() * (POSTER_COLS - 20), y: 4 + rand() * (POSTER_ROWS - 8), r: 3.5 + rand() * 4 }));
  for (let y = 0; y < POSTER_ROWS; y++) {
    let line = "";
    for (let x = 0; x < POSTER_COLS; x++) {
      // A character is about twice as tall as it is wide.
      let d = 0;
      for (const b of blobs) d += Math.exp(-(((x - b.x) / b.r) ** 2 + ((y - b.y) / (b.r * 0.45)) ** 2));
      line += RAMP[Math.min(RAMP.length - 1, Math.floor(d * (RAMP.length - 1) * 0.7))];
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function SceneCard({
  option: o,
  checked,
  tabbable,
  cardRef,
  onPick,
  onKeyDown,
}: {
  option: SceneOption;
  checked: boolean;
  tabbable: boolean;
  cardRef: (el: HTMLButtonElement | null) => void;
  onPick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const id = useId();
  const poster = useMemo(() => posterOf(o.id), [o.id]);
  const ext = o.file?.split(".").pop();
  return (
    <button
      ref={cardRef}
      type="button"
      role="radio"
      className="scene-card"
      aria-checked={checked}
      aria-disabled={o.error ? true : undefined}
      aria-labelledby={`${id}-name`}
      aria-describedby={`${id}-sub`}
      tabIndex={tabbable ? 0 : -1}
      data-scene={o.id}
      data-group={o.group}
      title={o.error ? `This scene has an error: ${o.error}` : undefined}
      style={o.group === "user" ? ({ "--scene-hue": hashOf(o.id) % 360 } as CSSProperties) : undefined}
      onClick={onPick}
      onKeyDown={onKeyDown}
    >
      <span className="scene-thumb" aria-hidden="true">
        {poster && <pre className="scene-poster">{poster}</pre>}
        {ext && <span className="scene-thumb-ext">{ext}</span>}
        {o.error && <span className="scene-thumb-error">!</span>}
        {checked && o.id !== "none" && (
          <span className="scene-live">
            <i />
            Live
          </span>
        )}
      </span>
      <span className="scene-card-text">
        <span className="scene-card-name" id={`${id}-name`}>
          {o.name}
        </span>
        <span className="scene-card-sub" id={`${id}-sub`}>
          {sceneSub(o)}
          {/* The tooltip has the error for the pointer; this is it for a screen reader. */}
          {o.error && <span className="sr-only">: {o.error}</span>}
        </span>
      </span>
      <span className="scene-card-check" aria-hidden="true">
        <IconCheck />
      </span>
    </button>
  );
}

/** The scenes as a gallery of cards, one radio group: arrows move the choice (past scenes with errors), Home/End. */
function SceneGallery({ value, options, onChange }: { value: string; options: SceneOption[]; onChange: (id: string) => void }) {
  const row = useRowLabel();
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  const usable = (i: number) => Boolean(options[i]) && !options[i].error;
  /** The first usable scene from `from`, stepping and wrapping; -1 when none is. */
  const seek = (from: number, step: 1 | -1): number => {
    const n = options.length;
    for (let k = 0, i = from; k < n; k++, i = (((i + step) % n) + n) % n) if (usable(i)) return i;
    return -1;
  };
  const selected = options.findIndex((o) => o.id === value);
  const tabbable = selected !== -1 && usable(selected) ? selected : seek(0, 1);

  const choose = (i: number) => {
    if (usable(i) && options[i].id !== value) onChange(options[i].id);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, at: number) => {
    const n = options.length;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? seek((at + 1) % n, 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? seek((at - 1 + n) % n, -1)
      : e.key === "Home" ? seek(0, 1)
      : e.key === "End" ? seek(n - 1, -1)
      : -1;
    if (next === -1) return;
    e.preventDefault();
    choose(next);
    cards.current[next]?.focus();
  };

  return (
    <div className="scene-gallery" role="radiogroup" data-part="scene-picker" aria-labelledby={row?.labelId} aria-describedby={row?.hintId}>
      {options.map((o, i) => (
        <SceneCard
          key={o.id}
          option={o}
          checked={i === selected}
          tabbable={i === tabbable}
          cardRef={(el) => {
            cards.current[i] = el;
          }}
          onPick={() => choose(i)}
          onKeyDown={(e) => onKeyDown(e, i)}
        />
      ))}
    </div>
  );
}

/** "sharks-deep.ts" → "Sharks deep": a name for a file the scene page hasn't named. */
const nameOfFile = (stem: string): string => {
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : stem;
};

// ── page ──

export function AppearanceTab() {
  const prefs = useStore((s) => s.prefs);
  const registered = useStore((s) => s.scenes);
  const theme = useAppliedTheme();
  const [folder, setFolder] = useState<{ dir: string; files: SceneFile[] } | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const rescan = async () => {
    setRescanning(true);
    try {
      setFolder(await window.kumo.app.scenes.list());
    } catch (err) {
      toast("error", `Couldn't read the scenes folder: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRescanning(false);
    }
  };

  useEffect(() => {
    void rescan();
    return window.kumo.app.scenes.onChanged(() => void rescan());
  }, []);

  const files = folder?.files ?? [];
  const user: SceneOption[] = files.map((f) => {
    const stem = f.file.replace(/\.(m?js|ts)$/i, "");
    const known = registered.find((s) => s.id === stem || s.id === f.file);
    return { id: known?.id ?? stem, name: known?.name || nameOfFile(stem), group: "user", file: f.file, error: f.error };
  });
  const userIds = new Set(user.map((u) => u.id));
  const builtIns = (registered.length > 0 ? registered.filter((s) => !userIds.has(s.id)) : BUILT_IN).filter((s) => s.id !== "none");
  const options: SceneOption[] = [
    ...builtIns.map((s): SceneOption => ({ id: s.id, name: s.name, group: "builtin" })),
    { id: "none", name: "None", group: "builtin" },
    ...user,
  ];

  const scene = prefs?.scene ?? "clouds";
  const broken = user.filter((u) => u.error).length;
  const themeList = useStore((s) => s.themes);
  const panelList = useStore((s) => s.panels);
  const activeTheme = themeList?.themes.find((t) => t.id === prefs?.theme);

  return (
    <>
      <PageHeader title="Appearance" description="Color, the background scene, where panels sit, and the glass. Changes show as you make them." />

      <Section label="Color">
        <Row label="Theme" hint="Follow the system, or keep Kumo dark (Night sky) or light (Frost).">
          <Segmented
            value={prefs?.mode ?? "system"}
            options={[
              ["system", "System"],
              ["dark", "Dark"],
              ["light", "Light"],
            ]}
            onChange={(mode) => void save({ mode })}
          />
        </Row>
        <Row label="Accent" hint="Focus, selection and the usage bars. The theme's own, a preset, or any color.">
          <AccentPicker />
        </Row>
        <Row
          label="Theme package"
          part="theme-package"
          hint={
            activeTheme?.error ?? (
              <>
                Colors and CSS from <span className="settings-path">{themeList?.dir ?? "your themes folder"}</span>. Start
                one with <code>kumo theme new</code>.
              </>
            )
          }
        >
          {themeList && themeList.themes.length > 0 && (
            <Segmented
              value={prefs?.theme ?? "default"}
              options={[["default", "Kumo"], ...themeList.themes.map((t): [string, string] => [t.id, t.name])]}
              onChange={(id) => void save({ theme: id === "default" ? null : id })}
            />
          )}
          <button type="button" className="btn sm" onClick={() => void window.kumo.app.themes.openFolder()}>
            <IconFolder />
            Open folder
          </button>
        </Row>
      </Section>

      <Section label="Background scene">
        <Row label="Scene" part="scene" hint="Built in, or your own .ts and .js files from the scenes folder.">
          <SceneGallery value={scene} options={options} onChange={(id) => void save({ scene: id })} />
        </Row>
        <Row label="Frame rate" hint="A lower cap saves battery and GPU time.">
          <Slider
            min={10}
            max={60}
            step={5}
            value={prefs?.sceneFps ?? 60}
            format={(v) => `${v} fps`}
            disabled={scene === "none"}
            onChange={(sceneFps) => previewPrefs({ sceneFps })}
          />
        </Row>
        <Row label="Grid" hint="A faint grid behind the scene.">
          <Toggle checked={prefs?.grid ?? true} onChange={(grid) => void save({ grid })} />
        </Row>
        <Row
          label="Your scenes"
          part="scene-folder"
          hint={
            folder ? (
              <>
                <span className="settings-path">{folder.dir}</span>
                {" · "}
                {files.length === 0 ? "No scene files yet" : `${files.length} file${files.length === 1 ? "" : "s"}`}
                {broken > 0 && `, ${broken} with errors`}
              </>
            ) : (
              "Reading the scenes folder…"
            )
          }
        >
          <button
            type="button"
            className="btn sm icon"
            aria-label="Rescan the scenes folder"
            data-tooltip="Rescan"
            data-tooltip-pos="top"
            aria-busy={rescanning || undefined}
            disabled={rescanning}
            onClick={() => void rescan()}
          >
            <IconRefresh />
          </button>
          <button type="button" className="btn sm" onClick={() => void window.kumo.app.scenes.openFolder()}>
            <IconFolder />
            Open folder
          </button>
        </Row>
      </Section>

      <Section label="Layout">
        <Row label="Workbench" hint="Where the Workbench sits, or hide it.">
          <Segmented
            value={prefs?.dock ?? "right"}
            options={[
              ["right", "Right"],
              ["bottom", "Bottom"],
              ["floating", "Floating"],
              ["hidden", "Hidden"],
            ]}
            onChange={(dock) => void save({ dock })}
          />
        </Row>
        <Row
          label="Custom panels"
          part="custom-panels"
          hint={
            <>
              Your own Workbench tabs, from <span className="settings-path">{panelList?.dir ?? "your panels folder"}</span>.
              Start one with <code>kumo panel new</code>.
            </>
          }
        >
          <button type="button" className="btn sm" onClick={() => void window.kumo.app.panels.openFolder()}>
            <IconFolder />
            Open folder
          </button>
        </Row>
      </Section>

      <Section label="Glass">
        <Row label="Blur" hint="How much the glass blurs what's behind it.">
          <Slider min={0} max={40} value={prefs?.glassBlur ?? 18} format={(v) => `${v}px`} onChange={(glassBlur) => previewPrefs({ glassBlur })} />
        </Row>
        <Row label="Opacity" hint="How much of the panel you see, and how little of the scene.">
          <Slider min={15} max={90} value={prefs?.glassOpacity ?? 46} format={(v) => `${v}%`} onChange={(glassOpacity) => previewPrefs({ glassOpacity })} />
        </Row>
        <Row
          label="Reduce transparency"
          hint={theme.osReducedTransparency ? "On in your system settings." : "Solid panels instead of glass."}
        >
          <Toggle
            checked={theme.osReducedTransparency || (prefs?.reduceTransparency ?? false)}
            disabled={theme.osReducedTransparency}
            onChange={(reduceTransparency) => void save({ reduceTransparency })}
          />
        </Row>
        <Row label="Reduce motion" hint={theme.osReducedMotion ? "On in your system settings." : "Fewer animations and transitions."}>
          <Toggle
            checked={theme.osReducedMotion || (prefs?.reduceMotion ?? false)}
            disabled={theme.osReducedMotion}
            onChange={(reduceMotion) => void save({ reduceMotion })}
          />
        </Row>
      </Section>
    </>
  );
}
