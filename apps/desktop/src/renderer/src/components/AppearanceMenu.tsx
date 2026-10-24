/**
 * Quick appearance settings: theme, scene, Workers dock, glass. Phase 3c
 * grows this into the full Appearance sheet with theme packages.
 */

import { useEffect, useRef } from "react";
import { savePrefs, setState, toast, useStore } from "../store";
import type { Prefs } from "../types";

const SCENES: Array<[string, string]> = [
  ["clouds", "Clouds"],
  ["stars", "Night sky"],
  ["none", "None"],
];

function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="setting">
      <span className="setting-label">{props.label}</span>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map(([value, text]) => (
          <button
            key={value}
            role="radio"
            aria-checked={props.value === value}
            onClick={() => props.onChange(value)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let unsaved: Partial<Prefs> = {};

function save(patch: Partial<Prefs>): void {
  savePrefs(patch).catch((err: Error) => toast("error", err.message));
}

/** Sliders apply at once and save when they settle. */
function preview(patch: Partial<Prefs>): void {
  setState((s) => (s.prefs ? { prefs: { ...s.prefs, ...patch } } : {}));
  unsaved = { ...unsaved, ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const patch = unsaved;
    unsaved = {};
    // Saved without reading the result back: the slider may have moved on.
    window.kumo.invoke("prefs.set", { patch }).catch((err: Error) => toast("error", err.message));
  }, 300);
}

export function AppearanceMenu({ onClose }: { onClose: () => void }) {
  const prefs = useStore((s) => s.prefs);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!prefs) return null;
  return (
    <div className="popover glass-strong" role="dialog" aria-label="Appearance" ref={ref} data-part="appearance">
      <Segmented
        label="Theme"
        value={prefs.mode}
        options={[
          ["system", "System"],
          ["light", "Light"],
          ["dark", "Dark"],
        ]}
        onChange={(mode) => save({ mode })}
      />
      <Segmented label="Scene" value={prefs.scene} options={SCENES} onChange={(scene) => save({ scene })} />
      <Segmented
        label="Workers"
        value={prefs.dock}
        options={[
          ["right", "Right"],
          ["bottom", "Bottom"],
          ["floating", "Float"],
          ["hidden", "Hidden"],
        ]}
        onChange={(dock) => save({ dock })}
      />
      <label className="setting">
        <span className="setting-label">
          Blur <span className="setting-value">{prefs.glassBlur}px</span>
        </span>
        <input
          type="range"
          min={0}
          max={40}
          value={prefs.glassBlur}
          onChange={(e) => preview({ glassBlur: Number(e.target.value) })}
        />
      </label>
      <label className="setting">
        <span className="setting-label">
          Glass <span className="setting-value">{prefs.glassOpacity}%</span>
        </span>
        <input
          type="range"
          min={15}
          max={90}
          value={prefs.glassOpacity}
          onChange={(e) => preview({ glassOpacity: Number(e.target.value) })}
        />
      </label>
      <label className="toggle">
        <input type="checkbox" checked={prefs.grid} onChange={(e) => save({ grid: e.target.checked })} />
        Grid behind the scene
      </label>
    </div>
  );
}
