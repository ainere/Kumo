/**
 * The building blocks every Settings tab uses, so the tabs read as one sheet.
 * Styles live in styles/settings.css.
 *
 * A page is a PageHeader, then Sections; a Section holds Rows (or anything);
 * a Row puts its label and hint on the left and one control on the right, and
 * the controls inside a Row (Toggle, Segmented, Slider, or your own through
 * useRowLabel) take the Row's label for screen readers.
 */

import "../../styles/settings.css";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/** Settings' top bar slot: a page's actions are portaled into it, beside "Back to chat". */
export const SettingsActionContext = createContext<HTMLElement | null>(null);

// ── page structure ──

/** Page header: the tab's title, a one-line description; `actions` go to the top bar. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  const slot = useContext(SettingsActionContext);
  return (
    <header className="settings-header">
      <div className="settings-header-text">
        <h1 className="settings-title">{title}</h1>
        {description && <p className="settings-desc">{description}</p>}
      </div>
      {actions && slot && createPortal(actions, slot)}
    </header>
  );
}

/** Section: a small-caps label (optional hint and actions) over a card of Rows; `plain` drops the card. */
export function Section({
  label,
  hint,
  actions,
  plain = false,
  part,
  children,
}: {
  label: string;
  hint?: ReactNode;
  actions?: ReactNode;
  plain?: boolean;
  part?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id} data-part={part}>
      <div className="settings-section-head">
        <h2 className="settings-section-label" id={id}>
          {label}
        </h2>
        {actions && <div className="settings-section-actions">{actions}</div>}
      </div>
      {hint && <p className="settings-section-hint">{hint}</p>}
      <div className={plain ? "settings-section-body" : "settings-card"}>{children}</div>
    </section>
  );
}

type RowLabel = { labelId: string; hintId: string | undefined } | null;
const RowContext = createContext<RowLabel>(null);

/** The enclosing Row's label and hint ids, for a control of your own: aria-labelledby / aria-describedby. */
export const useRowLabel = (): RowLabel => useContext(RowContext);

/** Row: label and hint on the left, the control (children) on the right; wraps under the text when narrow. */
export function Row({ label, hint, part, children }: { label: ReactNode; hint?: ReactNode; part?: string; children?: ReactNode }) {
  const id = useId();
  const ids = { labelId: `${id}-label`, hintId: hint ? `${id}-hint` : undefined };
  return (
    <div className="settings-row" data-part={part}>
      <div className="settings-row-text">
        <div className="settings-row-label" id={ids.labelId}>
          {label}
        </div>
        {hint && (
          <div className="settings-row-hint" id={ids.hintId}>
            {hint}
          </div>
        )}
      </div>
      {children !== undefined && (
        <div className="settings-row-control">
          <RowContext.Provider value={ids}>{children}</RowContext.Provider>
        </div>
      )}
    </div>
  );
}

/** Note: a quiet line of text in a card, for empty states and explanations. */
export function Note({ children }: { children: ReactNode }) {
  return <div className="settings-note">{children}</div>;
}

/** Callout: one message about the whole page (an error, a repair's result), with an optional action. */
export function Callout({
  tone,
  children,
  action,
  part,
}: {
  tone: "ok" | "warn" | "fail";
  children: ReactNode;
  action?: ReactNode;
  part?: string;
}) {
  return (
    <div className="settings-callout" data-tone={tone} data-part={part} role={tone === "fail" ? "alert" : "status"}>
      <StatusDot status={tone} />
      <div className="settings-callout-text">{children}</div>
      {action}
    </div>
  );
}

// ── controls ──

/** The accessible name: an explicit label wins, else the enclosing Row's. */
function useLabelProps(label: string | undefined) {
  const row = useRowLabel();
  return {
    "aria-label": label,
    "aria-labelledby": label ? undefined : row?.labelId,
    "aria-describedby": row?.hintId,
  };
}

/** Segmented: one choice of a few, as a radio group; arrow keys move the choice. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  value: T;
  options: ReadonlyArray<readonly [T, ReactNode]>;
  onChange: (value: T) => void;
  label?: string;
  disabled?: boolean;
}) {
  const labelProps = useLabelProps(label);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(
    0,
    options.findIndex(([v]) => v === value)
  );
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>, at: number) => {
    const n = options.length;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? (at + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (at - 1 + n) % n
      : e.key === "Home" ? 0
      : e.key === "End" ? n - 1
      : -1;
    if (next === -1) return;
    e.preventDefault();
    onChange(options[next][0]);
    refs.current[next]?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-disabled={disabled || undefined} {...labelProps}>
      {options.map(([v, text], i) => (
        <button
          key={v}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={v === value}
          tabIndex={i === current ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(v)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Toggle: an on/off switch (role="switch"); takes the Row's label unless given one. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  const labelProps = useLabelProps(label);
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...labelProps}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );
}

/**
 * Slider: a range with its value as text. With a label it stacks label and
 * value over the track; inside a Row it takes the Row's label and puts the
 * value beside the track. Pair with previewPrefs for preferences.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  label,
  format = String,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  label?: string;
  /** The value as shown and read out: 18 → "18px". */
  format?: (value: number) => string;
  disabled?: boolean;
}) {
  const row = useRowLabel();
  const id = useId();
  const text = format(value);
  const fill = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  const input = (
    <input
      type="range"
      className="slider-input"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-labelledby={label ? `${id}-label` : row?.labelId}
      aria-describedby={row?.hintId}
      aria-valuetext={text}
      style={{ "--fill": `${fill}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
  if (label) {
    return (
      <div className="slider" data-stacked="true">
        <div className="slider-head">
          <span id={`${id}-label`}>{label}</span>
          <span className="slider-value" aria-hidden="true">
            {text}
          </span>
        </div>
        {input}
      </div>
    );
  }
  return (
    <div className="slider">
      {input}
      <span className="slider-value" aria-hidden="true">
        {text}
      </span>
    </div>
  );
}

export type StatusKind = "ok" | "warn" | "fail" | "idle";

/** StatusDot: a small colored dot; give `label` when the dot alone carries the meaning. */
export function StatusDot({ status, label }: { status: StatusKind; label?: string }) {
  return label ? (
    <span className="status-dot" data-status={status} role="img" aria-label={label} title={label} />
  ) : (
    <span className="status-dot" data-status={status} aria-hidden="true" />
  );
}

/** Badge: a small label (a plan, a version, "live"); `mono` for ids and numbers. */
export function Badge({
  children,
  tone = "neutral",
  mono = false,
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "warn" | "fail";
  mono?: boolean;
  title?: string;
}) {
  return (
    <span className="badge" data-tone={tone} data-mono={mono || undefined} title={title}>
      {children}
    </span>
  );
}

// ── popovers ──

export type PopoverBox = { top?: number; bottom?: number; left: number; width: number; maxHeight: number };

/**
 * Where a popover portaled to the body goes: below its trigger when it fits
 * (else above), aligned to the trigger's right edge and kept in the window.
 * `width` sizes it from the trigger's box.
 */
export function usePopoverPlacement(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  width: (trigger: DOMRect) => number = (r) => Math.min(Math.max(r.width, 240), 300)
): PopoverBox | null {
  const [box, setBox] = useState<PopoverBox | null>(null);
  const size = useRef(width);
  size.current = width;
  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(size.current(r), vw - 16);
      let left = r.right - w;
      if (left < 8) left = 8;
      if (left + w > vw - 8) left = vw - w - 8;
      const below = vh - r.bottom - 14;
      const above = r.top - 14;
      if (below >= 280 || below >= above) setBox({ top: r.bottom + 6, left, width: w, maxHeight: Math.min(420, below) });
      else setBox({ bottom: vh - r.top + 6, left, width: w, maxHeight: Math.min(420, above) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor]);
  return box;
}

/**
 * Esc for something open inside a Modal or Settings: the Modal listens in the
 * capture phase on the document, so this listens earlier, on the window, and
 * keeps the key from it (and from Settings, which would close).
 */
export function useEscape(active: boolean, onEscape: () => void) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      handler.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active]);
}

// ── dialogs ──

/** Open dialogs, innermost last. Only the innermost one handles keys. */
const dialogStack: string[] = [];

/** True while any Modal is open: Settings' Esc leaves the key to it. */
export const hasOpenDialog = (): boolean => dialogStack.length > 0;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal: a dialog over everything (portal to body), labelled by its title.
 * Focus moves in (to `initialFocus`, else the first control), stays inside,
 * and returns to where it was on close. Esc and a click on the scrim call
 * onClose; the Esc never reaches Settings. `part` sets data-part.
 */
export function Modal({
  title,
  description,
  onClose,
  actions,
  part,
  initialFocus,
  dismissOnScrim = true,
  size = "sm",
  onKeyDown,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  /** Footer buttons, right-aligned; the primary one last. */
  actions?: ReactNode;
  part?: string;
  initialFocus?: RefObject<HTMLElement | null>;
  dismissOnScrim?: boolean;
  size?: "sm" | "md" | "lg";
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    dialogStack.push(id);
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocus?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current;
    target?.focus({ preventScroll: true });

    // Capture phase on the document: before anything else sees the key.
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack.at(-1) !== id || !ref.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      } else if (e.key === "Tab") {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const inside = ref.current.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const at = dialogStack.lastIndexOf(id);
      if (at !== -1) dialogStack.splice(at, 1);
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
    // Once per open dialog: onClose is read through a ref.
  }, []);

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (dismissOnScrim && e.target === e.currentTarget) close.current();
      }}
    >
      <div
        ref={ref}
        className="modal menu-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        data-part={part}
        data-size={size}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 className="modal-title" id={`${id}-title`}>
          {title}
        </h2>
        {description && (
          <p className="modal-desc" id={`${id}-desc`}>
            {description}
          </p>
        )}
        {children && <div className="modal-body">{children}</div>}
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>,
    document.body
  );
}
