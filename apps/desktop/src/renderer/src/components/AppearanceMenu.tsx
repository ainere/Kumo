/**
 * Quick appearance settings: theme, scene, Workers dock, glass. Phase 3c
 * grows this into the full Appearance sheet with theme packages.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { savePrefs, setState, toast, useStore } from "../store";
import type { Prefs } from "../types";


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

/**
 * Rendered at the root, not inside the title bar: a blurred element inside
 * another one only blurs what's inside its parent, so the panels below would
 * show through unblurred.
 */
export function AppearanceMenu({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const prefs = useStore((s) => s.prefs);
  const scenes = useStore((s) => s.scenes);
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: 0, right: 0 });

  useLayoutEffect(() => {
    const update = () => {
      const r = anchor?.getBoundingClientRect();
      if (r) setPlace({ top: Math.round(r.bottom + 10), right: Math.round(window.innerWidth - r.right) });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchor]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  if (!prefs) return null;
  return createPortal(
    <div
      className="popover menu-surface"
      role="dialog"
      aria-label="Appearance"
      ref={ref}
      data-part="appearance"
      style={{ top: place.top, right: place.right }}
    >
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
      <Segmented
        label="Scene"
        value={prefs.scene}
        options={[...scenes.map((s): [string, string] => [s.id, s.name]), ["none", "None"]]}
        onChange={(scene) => save({ scene })}
      />
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
    </div>,
    document.body
  );
}
