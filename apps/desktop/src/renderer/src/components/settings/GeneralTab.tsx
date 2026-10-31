/**
 * Settings › General: your name and standing instructions, how much Kumo asks
 * before it acts, its chimes, and which notices and confirmations it shows.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { getSafetyModeOption, SAFETY_MODE_OPTIONS } from "../../lib";
import { chime } from "../../sounds";
import { loadGlobalConfig, previewPrefs, savePrefs, saveProfile, toastFailure, updateSettings, useStore } from "../../store";
import type { Prefs } from "../../types";
import { IconCheck, SafetyIcon } from "../icons";
import { PageHeader, Row, Section, Slider, Toggle } from "./controls";

const save = (patch: Partial<Prefs>) => savePrefs(patch).catch((err) => toastFailure(err));

const MAX_NAME_CHARS = 80;
const MAX_INSTRUCTIONS_CHARS = 4000;
const SAVED_FLASH_MS = 2200;
const charCount = (text: string): number => [...text].length;

/** Name and standing instructions, saved to config.json and applied from the next turn. */
function ProfileCard() {
  const savedName = useStore((s) => s.globalConfig?.userName ?? null);
  const savedInstructions = useStore((s) => s.globalConfig?.customInstructions ?? null);
  const [name, setName] = useState(savedName ?? "");
  const [instructions, setInstructions] = useState(savedInstructions ?? "");
  const [savingName, setSavingName] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [flashName, setFlashName] = useState(false);
  const [flashInstructions, setFlashInstructions] = useState(false);
  const nameId = useId();
  const nameHintId = useId();
  const instructionsId = useId();
  const instructionsHintId = useId();

  const lastName = useRef(savedName);
  useEffect(() => {
    if (savedName !== null && (lastName.current === null || name === lastName.current)) setName(savedName);
    lastName.current = savedName;
  }, [savedName]);

  const lastInstructions = useRef(savedInstructions);
  useEffect(() => {
    if (savedInstructions !== null && (lastInstructions.current === null || instructions === lastInstructions.current)) {
      setInstructions(savedInstructions);
    }
    lastInstructions.current = savedInstructions;
  }, [savedInstructions]);

  useEffect(() => {
    if (!flashName) return;
    const timer = setTimeout(() => setFlashName(false), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashName]);

  useEffect(() => {
    if (!flashInstructions) return;
    const timer = setTimeout(() => setFlashInstructions(false), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flashInstructions]);

  const trimmedName = name.trim();
  const trimmedInstructions = instructions.trim();
  const nameChars = charCount(trimmedName);
  const instructionsChars = charCount(trimmedInstructions);
  const nameTooLong = nameChars > MAX_NAME_CHARS;
  const instructionsTooLong = instructionsChars > MAX_INSTRUCTIONS_CHARS;
  const nameDirty = savedName !== null && trimmedName !== savedName;
  const instructionsDirty = savedInstructions !== null && trimmedInstructions !== savedInstructions;

  const commitName = async () => {
    if (!nameDirty || nameTooLong || savingName) {
      if (!nameDirty && savedName !== null && name !== savedName) setName(savedName);
      return;
    }
    setSavingName(true);
    const ok = await saveProfile({ userName: trimmedName });
    setSavingName(false);
    if (ok) {
      setName(trimmedName);
      setFlashName(true);
    }
  };

  const commitInstructions = async () => {
    if (!instructionsDirty || instructionsTooLong || savingInstructions) {
      if (!instructionsDirty && savedInstructions !== null && instructions !== savedInstructions) {
        setInstructions(savedInstructions);
      }
      return;
    }
    setSavingInstructions(true);
    const ok = await saveProfile({ customInstructions: trimmedInstructions });
    setSavingInstructions(false);
    if (ok) {
      setInstructions(trimmedInstructions);
      setFlashInstructions(true);
    }
  };

  return (
    <>
      <div className="settings-row" data-part="profile-name">
        <div className="settings-row-text">
          <label className="settings-row-label" htmlFor={nameId}>
            What Kumo should call you
          </label>
          <div
            className="settings-row-hint"
            id={nameHintId}
            data-tone={nameTooLong ? "fail" : flashName ? "ok" : undefined}
          >
            {nameTooLong
              ? `At most ${MAX_NAME_CHARS} characters (currently ${nameChars}).`
              : flashName
                ? "Saved. Applies from the next turn."
                : "Passed to the lead only, never to workers."}
          </div>
        </div>
        <div className="settings-row-control">
          <input
            id={nameId}
            type="text"
            className="field profile-name-input"
            placeholder="Optional"
            value={name}
            disabled={savedName === null}
            aria-describedby={nameHintId}
            aria-invalid={nameTooLong || undefined}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void commitName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitName();
              } else if (e.key === "Escape" && nameDirty) {
                e.preventDefault();
                e.stopPropagation();
                setName(savedName ?? "");
              }
            }}
          />
        </div>
      </div>

      <div className="settings-row profile-instructions-row" data-part="profile-instructions">
        <div className="profile-instructions-head">
          <div className="settings-row-text">
            <label className="settings-row-label" htmlFor={instructionsId}>
              Standing instructions
              <span className="settings-row-aside" data-tone={instructionsTooLong ? "fail" : undefined}>
                {instructionsChars} / {MAX_INSTRUCTIONS_CHARS}
              </span>
            </label>
            <div
              className="settings-row-hint"
              id={instructionsHintId}
              data-tone={instructionsTooLong ? "fail" : flashInstructions ? "ok" : undefined}
            >
              {instructionsTooLong
                ? `At most ${MAX_INSTRUCTIONS_CHARS} characters.`
                : flashInstructions
                  ? "Saved. Applies from the next turn."
                  : "Conventions, preferences or constraints for both the lead and every worker role. Saved when you leave the field or press Ctrl+Enter."}
            </div>
          </div>
          {instructionsDirty && (
            <div className="profile-instructions-actions">
              <button
                type="button"
                className="btn sm ghost"
                disabled={savingInstructions}
                onClick={() => setInstructions(savedInstructions ?? "")}
              >
                Revert
              </button>
              <button
                type="button"
                className="btn sm primary"
                disabled={savingInstructions || instructionsTooLong}
                onClick={() => void commitInstructions()}
              >
                {savingInstructions ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
        <textarea
          id={instructionsId}
          className="field profile-instructions-input"
          rows={4}
          placeholder="e.g. Prefer concise answers, run narrow tests before full suites, and follow existing file conventions."
          value={instructions}
          disabled={savedInstructions === null}
          aria-describedby={instructionsHintId}
          aria-invalid={instructionsTooLong || undefined}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => void commitInstructions()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void commitInstructions();
            } else if (e.key === "Escape" && instructionsDirty) {
              e.preventDefault();
              e.stopPropagation();
              setInstructions(savedInstructions ?? "");
            }
          }}
        />
      </div>
    </>
  );
}

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
      <PageHeader title="General" description="What Kumo knows about you, how much it asks before it acts, its chimes, and the notices it shows." />

      <Section
        label="Profile"
        hint="Standing preferences saved across every project and chat. Changes take effect on the next turn without restarting the conversation."
        part="profile"
      >
        <ProfileCard />
      </Section>

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
