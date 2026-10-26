/**
 * Settings › General: how much Kumo asks before it acts, its chimes, and
 * which notices and confirmations it shows.
 */

import { useEffect, useRef, type KeyboardEvent } from "react";
import { getSafetyModeOption, SAFETY_MODE_OPTIONS } from "../../lib";
import { chime } from "../../sounds";
import { loadGlobalConfig, previewPrefs, savePrefs, toastFailure, updateSettings, useStore } from "../../store";
import type { Prefs } from "../../types";
import { IconCheck, SafetyIcon } from "../icons";
import { PageHeader, Row, Section, Slider, Toggle } from "./controls";

const save = (patch: Partial<Prefs>) => savePrefs(patch).catch((err) => toastFailure(err));

/** The three tiers as cards: the choice that matters most on this page gets the room to explain itself. */
function SafetyTiers() {
  const session = useStore((s) => s.session);
  const globalConfig = useStore((s) => s.globalConfig);
  const cards = useRef<Array<HTMLButtonElement | null>>([]);
  const mode = session?.settings.safetyMode ?? globalConfig?.settings.safetyMode;
  // Until the engine says which tier is on, none is shown as on.
  const known = mode !== undefined;
  const current = known ? getSafetyModeOption(mode).id : null;
  const at = SAFETY_MODE_OPTIONS.findIndex((o) => o.id === current);

  const choose = (id: string) => {
    if (known && id !== current) void updateSettings({ safetyMode: id });
  };

  // Arrows stop at the ends: Hands-On never wraps round to Autopilot.
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = SAFETY_MODE_OPTIONS.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? Math.min(last, i + 1)
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? Math.max(0, i - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : -1;
    if (next === -1 || next === i) return;
    e.preventDefault();
    choose(SAFETY_MODE_OPTIONS[next].id);
    cards.current[next]?.focus();
  };

  return (
    <div className="tier-cards" role="radiogroup" aria-label="Safety mode" aria-busy={!known || undefined} data-part="safety-tiers">
      {SAFETY_MODE_OPTIONS.map((o, i) => (
        <button
          key={o.id}
          ref={(el) => {
            cards.current[i] = el;
          }}
          type="button"
          role="radio"
          className="tier-card"
          aria-checked={i === at}
          tabIndex={i === (at === -1 ? 0 : at) ? 0 : -1}
          disabled={!known}
          data-tier={o.id}
          onClick={() => choose(o.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span className="tier-card-head">
            <span className="tier-card-icon" aria-hidden="true">
              <SafetyIcon type={o.iconType} />
            </span>
            <span className="tier-card-name">{o.label}</span>
            <span className="tier-card-check" aria-hidden="true">
              <IconCheck />
            </span>
          </span>
          <span className="tier-card-desc">{o.desc}</span>
        </button>
      ))}
    </div>
  );
}

export function GeneralTab() {
  const prefs = useStore((s) => s.prefs);
  const globalConfig = useStore((s) => s.globalConfig);

  useEffect(() => {
    if (!globalConfig) void loadGlobalConfig();
  }, [globalConfig]);

  const volume = prefs?.soundVolume ?? 50;
  const sounds = prefs?.sounds ?? true;

  return (
    <>
      <PageHeader title="General" description="How much Kumo asks before it acts, its chimes, and the notices it shows." />

      <Section label="Safety" hint="Who approves the file changes workers make. The shield button in the composer switches this too." plain>
        <SafetyTiers />
      </Section>

      <Section label="Sounds">
        <Row label="Chimes" hint="A soft chime when a long turn finishes or an approval is waiting.">
          <Toggle checked={sounds} onChange={(on) => void save({ sounds: on })} />
        </Row>
        <Row label="Volume">
          <Slider
            min={0}
            max={100}
            value={volume}
            format={(v) => `${v}%`}
            disabled={!sounds}
            onChange={(soundVolume) => previewPrefs({ soundVolume })}
          />
        </Row>
        <Row label="Preview" hint="Hear each chime at this volume.">
          <button type="button" className="btn sm" disabled={!sounds} onClick={() => chime("done", volume)}>
            Turn finished
          </button>
          <button type="button" className="btn sm" disabled={!sounds} onClick={() => chime("approval", volume)}>
            Approval waiting
          </button>
        </Row>
      </Section>

      <Section label="Notices">
        <Row label="Error notifications" hint="A notification when something running in the background fails.">
          <Toggle checked={prefs?.errorToasts ?? true} onChange={(on) => void save({ errorToasts: on })} />
        </Row>
        <Row
          label="Ask before switching providers"
          hint="When a chat continues on another lead provider, its earlier turns are replayed into the new model's context. Confirm first."
        >
          <Toggle checked={!prefs?.skipProviderSwitchWarning} onChange={(on) => void save({ skipProviderSwitchWarning: !on })} />
        </Row>
      </Section>
    </>
  );
}
