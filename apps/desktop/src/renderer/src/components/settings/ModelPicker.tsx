/**
 * ModelPicker: the model one role runs on, chosen from the providers the
 * user is signed in to (Settings › Roles, the custom-role editor, the
 * first-run wizard).
 *
 * A select-only combobox: focus stays on the trigger, the listbox floats over
 * everything (portal to body) and follows the trigger as the page scrolls.
 * Options are grouped by provider. Models the role can't use stay in the
 * list, disabled, and say why, so keyboard and screen-reader users hear the
 * reason too. A provider that takes any model id (Ollama, an OpenAI-compatible
 * endpoint, …) and lists none offers "Custom model id…", which opens a small
 * field under the trigger.
 *
 * The helpers below mirror the engine's rules (src/config/models.js,
 * src/providers/workers/capabilities.js) so the UI never offers a value the
 * engine would reject.
 */

import "../../styles/settings-roles.css";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { providerLabel } from "../../lib";
import type { CatalogModel, CatalogProvider } from "../../types";
import { IconCheck, IconChevronRight, IconPlus } from "../icons";
import { useEscape, usePopoverPlacement, useRowLabel } from "./controls";

// ── engine rules, mirrored ──

/** src/config/models.js MODEL_ID_PATTERN: ids are passed raw to provider CLIs. */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
/** src/config/models.js EFFORT_LEVELS. */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** What the role needs from its model: the lead calls worker tools, a write role edits files. */
export type ModelNeed = "lead" | "write" | "read";
/** A role's own model. */
export type ModelTarget = { provider: string; model: string; effort?: string };

/** "agy" and "antigravity" are one provider. */
export const canonicalProvider = (p: string | null | undefined): string => {
  const v = (p ?? "").trim().toLowerCase();
  return v === "agy" ? "antigravity" : v;
};

export function findProvider(catalog: CatalogProvider[] | null, provider: string): CatalogProvider | null {
  const id = canonicalProvider(provider);
  return catalog?.find((p) => canonicalProvider(p.provider) === id) ?? null;
}

export function findModel(catalog: CatalogProvider[] | null, provider: string, model: string): CatalogModel | null {
  return findProvider(catalog, provider)?.models.find((m) => m.id === model) ?? null;
}

/** "Claude Code", from the catalog when it has the provider. */
export const providerName = (catalog: CatalogProvider[] | null, provider: string): string =>
  findProvider(catalog, provider)?.name || providerLabel(canonicalProvider(provider)) || provider;

/** "Claude Sonnet 5.5", or the id when the catalog doesn't know it. */
export const modelName = (catalog: CatalogProvider[] | null, provider: string, model: string): string =>
  findModel(catalog, provider, model)?.name || model;

/**
 * Whether a provider can fill a write role. Any can (capabilities.js: a worker
 * that cannot edit files proposes a diff and the bridge applies it), so before
 * the catalog has loaded the answer is yes.
 */
export function canWrite(catalog: CatalogProvider[] | null, provider: string): boolean {
  return findProvider(catalog, provider)?.canWrite ?? true;
}

/** Why a provider can't serve this role, or null when it can. */
export function needReason(entry: Pick<CatalogProvider, "canWrite" | "canLead">, need: ModelNeed): string | null {
  if (need === "lead" && !entry.canLead) return "Can't call worker tools";
  if (need === "write" && !entry.canWrite) return "Can't write files";
  return null;
}

/** The efforts a model takes, limited to the levels Kumo accepts. */
export const effortsOf = (model: CatalogModel | null): string[] =>
  (model?.efforts ?? []).filter((e) => EFFORT_LEVELS.includes(e));

/**
 * The effort to use for a model: the current one when the model takes it,
 * else the nearest level below it that the model has (Max on a Gemini model
 * runs at High), else the model's default, else medium, else its first
 * level. Undefined when the model picks its own.
 */
export function pickEffort(model: CatalogModel | null, current?: string): string | undefined {
  const efforts = effortsOf(model);
  if (efforts.length === 0) return undefined;
  if (current && efforts.includes(current)) return current;
  for (let i = current ? EFFORT_LEVELS.indexOf(current) - 1 : -1; i >= 0; i--) if (efforts.includes(EFFORT_LEVELS[i])) return EFFORT_LEVELS[i];
  if (model?.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts.includes("medium") ? "medium" : efforts[0];
}

/** What a provider calls a level, where it isn't the level's own name: `xhigh` is Claude Code's "Extra" and Codex's "Extra high". */
const EFFORT_NAMES: Record<string, Record<string, string>> = {
  claude: { xhigh: "Extra" },
  codex: { xhigh: "Extra high" },
};

/** An effort as its provider names it: "Extra" for Claude Code's `xhigh`, "High" for `high`. */
export const effortLabel = (provider: string, effort: string): string =>
  EFFORT_NAMES[canonicalProvider(provider)]?.[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);

// ── options ──

type Option = {
  kind: "default" | "model" | "custom";
  provider: string;
  model: string;
  label: string;
  /** The model id, in mono, when it differs from the label. */
  id: string | null;
  sub: string | null;
  /** Why it can't be chosen; null when it can. */
  disabled: string | null;
  /** A reason of this option's own (not its provider's), shown on it. */
  ownReason: string | null;
  selected: boolean;
};

type Group = { key: string; label: string | null; reason: string | null; tone: "warn" | null; options: Option[] };

type DefaultWorker = { provider: string; model: string; effort?: string };

function buildGroups(
  catalog: CatalogProvider[] | null,
  value: ModelTarget | null,
  need: ModelNeed,
  defaultWorker: DefaultWorker | null | undefined
): Group[] {
  const groups: Group[] = [];
  const valueProvider = value ? canonicalProvider(value.provider) : null;

  if (defaultWorker) {
    const dw = defaultWorker;
    const parts = [modelName(catalog, dw.provider, dw.model), providerName(catalog, dw.provider), dw.effort && effortLabel(dw.provider, dw.effort)].filter(Boolean);
    const blocked = need === "write" && !canWrite(catalog, dw.provider) ? "The default worker can't write files" : null;
    groups.push({
      key: "default",
      label: null,
      reason: null,
      tone: null,
      options: [
        {
          kind: "default",
          provider: "",
          model: "",
          label: "Default worker",
          id: null,
          sub: blocked ?? parts.join(" · "),
          disabled: blocked,
          ownReason: blocked,
          selected: value === null,
        },
      ],
    });
  }

  // The current choice on a provider that isn't signed in: still shown, flagged.
  const current = value && valueProvider ? findProvider(catalog, valueProvider) : null;
  if (value && valueProvider && !current?.available) {
    groups.push({
      key: `off-${valueProvider}`,
      label: providerName(catalog, valueProvider),
      reason: "Not signed in",
      tone: "warn",
      options: [
        {
          kind: "model",
          provider: valueProvider,
          model: value.model,
          label: modelName(catalog, valueProvider, value.model),
          id: value.model,
          sub: null,
          disabled: null,
          ownReason: null,
          selected: true,
        },
      ],
    });
  }

  const usable: Group[] = [];
  const blocked: Group[] = [];
  for (const entry of catalog ?? []) {
    if (!entry.available) continue;
    const provider = canonicalProvider(entry.provider);
    const reason = needReason(entry, need);
    const options: Option[] = [];
    const listed = entry.models.some((m) => provider === valueProvider && m.id === value?.model);
    if (value && provider === valueProvider && !listed) {
      // A hand-typed id, or one the provider no longer lists: keep it visible.
      options.push({
        kind: "model",
        provider,
        model: value.model,
        label: value.model,
        id: null,
        sub: entry.models.length === 0 ? "Custom model id" : "Not in this provider's list",
        disabled: null,
        ownReason: null,
        selected: true,
      });
    }
    for (const m of entry.models) {
      const badId = MODEL_ID_PATTERN.test(m.id) ? null : "Kumo can't pass this id to the CLI";
      options.push({
        kind: "model",
        provider,
        model: m.id,
        label: m.name || m.id,
        id: m.name && m.name !== m.id ? m.id : null,
        sub: badId ?? m.desc,
        disabled: reason ?? badId,
        ownReason: badId,
        selected: value !== null && provider === valueProvider && m.id === value.model,
      });
    }
    if (entry.models.length === 0) {
      options.push({
        kind: "custom",
        provider,
        model: "",
        label: "Custom model id…",
        id: null,
        sub: `Any model ${entry.name} can run`,
        disabled: reason,
        ownReason: null,
        selected: false,
      });
    }
    (reason ? blocked : usable).push({ key: provider, label: entry.name, reason, tone: null, options });
  }
  return [...groups, ...usable, ...blocked];
}

// ── the picker ──

export interface ModelPickerProps {
  catalog: CatalogProvider[] | null;
  /** The role's own model; null when it follows the default worker. */
  value: ModelTarget | null;
  /** A model, or null for "Default worker". The caller picks the effort (pickEffort). */
  onChange: (next: ModelTarget | null) => void;
  /** Disables the providers this role can't run on, with the reason. */
  need?: ModelNeed;
  /** Offers "Default worker" and shows what it resolves to. Omit for the lead and the default worker itself. */
  defaultWorker?: DefaultWorker | null;
  /** Accessible name; else the enclosing Row's label, else `labelledBy`. */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  /** Marks the value as not allowed (the editor shows why). */
  invalid?: boolean;
  disabled?: boolean;
  /** The trigger's id, for a <label htmlFor>. */
  id?: string;
}

export function ModelPicker({
  catalog,
  value,
  onChange,
  need = "read",
  defaultWorker,
  label,
  labelledBy,
  describedBy,
  invalid = false,
  disabled = false,
  id,
}: ModelPickerProps) {
  const row = useRowLabel();
  const base = useId();
  const listId = `${base}-list`;
  const flagId = `${base}-flag`;
  const optId = (i: number) => `${base}-opt-${i}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [customFor, setCustomFor] = useState<string | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const groups = useMemo(() => buildGroups(catalog, value, need, defaultWorker), [catalog, value, need, defaultWorker]);
  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const box = usePopoverPlacement(trigger, open);
  const loading = catalog === null;

  useEscape(open, () => setOpen(false));

  // Keep the active option in view.
  useEffect(() => {
    if (open && active >= 0) document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const firstEnabled = (from: number, step: 1 | -1): number => {
    for (let i = from; i >= 0 && i < flat.length; i += step) if (!flat[i].disabled) return i;
    return -1;
  };

  const openAt = (where: "selected" | "first" | "last") => {
    if (disabled || loading) return;
    const selected = flat.findIndex((o) => o.selected);
    const at =
      where === "first" ? 0
      : where === "last" ? flat.length - 1
      : selected !== -1 ? selected
      : Math.max(0, firstEnabled(0, 1));
    setCustomFor(null);
    setActive(at);
    setOpen(true);
  };

  const choose = (i: number) => {
    const option = flat[i];
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.kind === "custom") {
      setCustomFor(option.provider);
      return;
    }
    if (option.selected) return;
    onChange(option.kind === "default" ? null : { provider: option.provider, model: option.model });
  };

  /** Type-ahead: jump to the next option whose label starts with what was typed. */
  const typeAhead = (char: string) => {
    const now = Date.now();
    const text = (now - typed.current.at < 600 ? typed.current.text : "") + char.toLowerCase();
    typed.current = { text, at: now };
    const start = text.length === 1 ? active + 1 : Math.max(0, active);
    for (let k = 0; k < flat.length; k++) {
      const i = (start + k) % flat.length;
      if (flat[i].label.toLowerCase().startsWith(text)) {
        setActive(i);
        return;
      }
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openAt("selected");
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        openAt(e.key === "Home" ? "first" : "last");
      } else if (printable) {
        e.preventDefault();
        openAt("selected");
        typeAhead(e.key);
      }
      return;
    }
    const last = flat.length - 1;
    const move = (i: number) => {
      e.preventDefault();
      setActive(Math.min(last, Math.max(0, i)));
    };
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") e.altKey ? (e.preventDefault(), choose(active)) : move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(last);
    else if (e.key === "PageDown") move(active + 8);
    else if (e.key === "PageUp") move(active - 8);
    else if (e.key === "Enter" || (e.key === " " && typed.current.text === "")) {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Tab") setOpen(false);
    else if (printable) {
      e.preventDefault();
      typeAhead(e.key);
    }
  };

  // What the trigger shows.
  const provider = value ? canonicalProvider(value.provider) : null;
  const entry = provider ? findProvider(catalog, provider) : null;
  let name: string;
  let sub: string;
  let flag: string | null = null;
  let mono = false;
  if (!value) {
    name = defaultWorker ? "Default worker" : "Not set";
    sub = defaultWorker
      ? `${modelName(catalog, defaultWorker.provider, defaultWorker.model)} · ${providerName(catalog, defaultWorker.provider)}`
      : "";
    if (defaultWorker && need === "write" && !canWrite(catalog, defaultWorker.provider)) flag = "The default worker can't write files";
  } else {
    const known = findModel(catalog, value.provider, value.model);
    name = known?.name || value.model;
    mono = !known?.name;
    sub = providerName(catalog, value.provider);
    if (!loading && !entry?.available) flag = `${sub} isn't signed in`;
    else if (entry && need !== "read" && needReason(entry, need)) flag = `${sub} ${needReason(entry, need)!.replace(/^Can't/, "can't")}`;
  }

  const describe = [describedBy ?? (label ? undefined : row?.hintId), flag ? flagId : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <div className="model-picker">
      <button
        ref={trigger}
        id={id}
        type="button"
        role="combobox"
        className="model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
        aria-label={label}
        aria-labelledby={label ? undefined : (labelledBy ?? row?.labelId)}
        aria-describedby={describe}
        aria-invalid={invalid || undefined}
        aria-busy={loading || undefined}
        data-flag={flag ? "warn" : undefined}
        data-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openAt("selected"))}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {flag && <span className="model-trigger-dot" aria-hidden="true" />}
        <span className="model-trigger-text">
          <span className="model-trigger-name" data-mono={mono || undefined}>
            {name}
          </span>
          <span className="model-trigger-sub">
            {flag ? (
              <span id={flagId}>{flag}</span>
            ) : loading ? (
              <>{sub}</>
            ) : (
              sub
            )}
          </span>
        </span>
        <IconChevronRight className="model-trigger-chevron" />
      </button>

      {customFor && (
        <CustomModelField
          providerName={providerName(catalog, customFor)}
          onCancel={() => {
            setCustomFor(null);
            trigger.current?.focus();
          }}
          onUse={(model) => {
            const target = { provider: customFor, model };
            setCustomFor(null);
            trigger.current?.focus();
            if (!(value && canonicalProvider(value.provider) === customFor && value.model === model)) onChange(target);
          }}
        />
      )}

      {open &&
        box &&
        createPortal(
          <div
            className="model-popover menu-surface"
            style={{ top: box.top, bottom: box.bottom, left: box.left, width: box.width, maxHeight: box.maxHeight } as CSSProperties}
            data-placement={box.top !== undefined ? "below" : "above"}
            // Clicks inside keep the focus on the trigger.
            onMouseDown={(e) => e.preventDefault()}
          >
            <div
              ref={list}
              role="listbox"
              id={listId}
              aria-label={label}
              aria-labelledby={label ? undefined : (labelledBy ?? row?.labelId)}
              className="model-list"
            >
              {(() => {
                let index = 0;
                return groups.map((group) => {
                  const headId = `${base}-g-${group.key}`;
                  const reasonId = `${headId}-why`;
                  const options = group.options.map((option) => {
                    const i = index++;
                    const describedByReason = option.disabled && !option.ownReason ? reasonId : undefined;
                    return (
                      <div
                        key={`${option.kind}:${option.provider}:${option.model}`}
                        id={optId(i)}
                        role="option"
                        className="model-option"
                        data-kind={option.kind}
                        data-active={i === active || undefined}
                        aria-selected={option.selected}
                        aria-disabled={option.disabled ? true : undefined}
                        aria-describedby={describedByReason}
                        onMouseMove={() => i !== active && setActive(i)}
                        onClick={() => choose(i)}
                      >
                        <span className="model-option-mark" aria-hidden="true">
                          {option.kind === "custom" ? <IconPlus /> : option.selected ? <IconCheck /> : null}
                        </span>
                        <span className="model-option-name" data-mono={option.label === option.model && option.kind === "model" ? true : undefined}>
                          {option.label}
                        </span>
                        {option.id && <span className="model-option-id">{option.id}</span>}
                        {option.sub && (
                          <span className="model-option-sub" data-reason={option.ownReason ? true : undefined}>
                            {option.sub}
                          </span>
                        )}
                      </div>
                    );
                  });
                  if (group.label === null) {
                    return (
                      <div key={group.key} role="group" aria-label="Default" className="model-group" data-kind="default">
                        {options}
                      </div>
                    );
                  }
                  return (
                    <div key={group.key} role="group" aria-labelledby={headId} className="model-group" data-blocked={group.reason && !group.tone ? true : undefined}>
                      <div className="model-group-head" id={headId}>
                        <span>{group.label}</span>
                        {group.reason && (
                          <span className="model-group-reason" id={reasonId} data-tone={group.tone ?? undefined}>
                            {group.reason}
                          </span>
                        )}
                      </div>
                      {options}
                    </div>
                  );
                });
              })()}
              {flat.length === 0 && <div className="model-empty">No signed-in provider has models yet.</div>}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/** A model id typed by hand, for a provider that takes any id and lists none. */
function CustomModelField({ providerName: name, onUse, onCancel }: { providerName: string; onUse: (model: string) => void; onCancel: () => void }) {
  const base = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const clean = text.trim();
  const error = !clean ? (tried ? "Enter a model id" : null) : MODEL_ID_PATTERN.test(clean) ? null : "Letters, digits, '.', '_', '-', ':' and '/' only, up to 120, starting with a letter or digit";

  useEffect(() => {
    input.current?.focus();
  }, []);

  // Esc cancels the field, not the dialog or Settings around it.
  const [focused, setFocused] = useState(true);
  useEscape(focused, onCancel);

  const submit = () => {
    setTried(true);
    if (clean && MODEL_ID_PATTERN.test(clean)) onUse(clean);
  };

  return (
    <div className="model-custom" role="group" aria-labelledby={`${base}-label`}>
      <label className="model-custom-label" id={`${base}-label`} htmlFor={`${base}-input`}>
        Model id for {name}
      </label>
      <div className="model-custom-row">
        <input
          ref={input}
          id={`${base}-input`}
          className="roles-input"
          data-mono="true"
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="e.g. qwen3-coder"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${base}-error` : undefined}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="button" className="btn sm primary" onClick={submit}>
          Use
        </button>
        <button type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="roles-field-error" id={`${base}-error`}>
          {error}
        </div>
      )}
    </div>
  );
}
