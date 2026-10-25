/**
 * Onboarding: the first-run wizard, over the live scene.
 *   1. Accounts: which provider CLIs are here and signed in; sign in to more.
 *   2. Roles: the lead and the shared worker, from the signed-in providers.
 *   3. Project: the folder to start in.
 * Skippable at any step; Settings has everything it sets.
 */

import "../styles/settings.css";
import "../styles/onboarding.css";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { finishOnboarding, loadAccounts, loadCatalog, loadGlobalConfig, signIn, updateSettings, useStore } from "../store";
import type { AccountStatus } from "../types";
import { IconArrowLeft, IconCheck, IconFolder, IconRefresh } from "./icons";
import { Badge, Callout, StatusDot } from "./settings/controls";
import { findModel, ModelPicker, pickEffort, type ModelTarget } from "./settings/ModelPicker";

const STEPS = ["Accounts", "Roles", "Project"] as const;
type Step = 0 | 1 | 2;

export function Onboarding() {
  const [step, setStep] = useState<Step>(0);
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const [workspace, setWorkspace] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(() => {
    void loadAccounts();
    void loadCatalog();
    void loadGlobalConfig();
  }, []);

  // A new step takes the focus to its heading, so it doesn't fall to the page when the clicked button goes.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  const go = (next: Step) => {
    setDir(next > step ? "forward" : "back");
    setStep(next);
  };

  const finish = async (folder: string | null) => {
    if (finishing) return;
    setFinishing(true);
    setOpenFailed(false);
    const ok = await finishOnboarding(folder);
    // On success the wizard is gone; otherwise it stays to pick another folder.
    if (!ok) {
      setFinishing(false);
      setOpenFailed(Boolean(folder));
    }
  };

  const folder = workspace.trim();

  return (
    <div className="onboarding-stage" data-part="onboarding">
      <section className="onboarding glass-strong" aria-labelledby={titleId}>
        <header className="onboarding-head">
          <div className="onboarding-head-text">
            <h1 className="onboarding-title" id={titleId}>
              Welcome to Kumo
            </h1>
            <p className="onboarding-lede">Your accounts, who does what, and a project to start in. A minute or two.</p>
          </div>
          <button type="button" className="btn sm ghost" data-part="onboarding-skip" disabled={finishing} onClick={() => void finish(null)}>
            Skip setup
          </button>
        </header>

        <ol className="onboarding-steps" aria-label="Setup steps">
          {STEPS.map((label, i) => (
            <li key={label} className="onboarding-step" data-state={i < step ? "done" : i === step ? "current" : "todo"} aria-current={i === step ? "step" : undefined}>
              <span className="onboarding-step-dot" aria-hidden="true">
                {i < step ? <IconCheck /> : i + 1}
              </span>
              <span className="onboarding-step-label">{label}</span>
              {i < step && <span className="sr-only">(done)</span>}
            </li>
          ))}
        </ol>

        <div className="onboarding-body" key={step} data-dir={dir}>
          {step === 0 && <AccountsStep heading={heading} />}
          {step === 1 && <RolesStep heading={heading} />}
          {step === 2 && (
            <ProjectStep heading={heading} value={workspace} onChange={setWorkspace} disabled={finishing} failed={openFailed} onEdit={() => setOpenFailed(false)} />
          )}
        </div>

        <footer className="onboarding-foot">
          {step > 0 ? (
            <button type="button" className="btn ghost" disabled={finishing} onClick={() => go((step - 1) as Step)}>
              <IconArrowLeft />
              Back
            </button>
          ) : (
            <span />
          )}
          {step < 2 ? (
            <button type="button" className="btn primary" data-part="onboarding-next" onClick={() => go((step + 1) as Step)}>
              Continue
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              data-part="onboarding-finish"
              aria-busy={finishing || undefined}
              disabled={finishing}
              onClick={() => void finish(folder || null)}
            >
              {finishing ? (folder ? "Opening…" : "Finishing…") : folder ? "Open project" : "Finish without a project"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

// ── 1. accounts ──

/** What the step lists: the CLIs, and any key or local server that's ready to use. */
const listed = (a: AccountStatus) => a.kind === "subscription" || a.signedIn === true;

/** Signed in first, then can't tell, not signed in, not installed. */
const rank = (a: AccountStatus): number => (!a.installed ? 3 : a.signedIn === true ? 0 : a.signedIn === null ? 1 : 2);

function AccountsStep({ heading }: { heading: RefObject<HTMLHeadingElement | null> }) {
  const accounts = useStore((s) => s.accounts);
  const signingIn = useStore((s) => s.signingIn);
  const loadError = useStore((s) => s.loadErrors.accounts);
  const [rescanning, setRescanning] = useState(false);

  const rescan = async () => {
    setRescanning(true);
    await loadAccounts(true);
    setRescanning(false);
  };

  const list = (accounts ?? []).filter(listed).sort((a, b) => rank(a) - rank(b));
  const ready = list.filter((a) => a.signedIn === true).length;

  return (
    <>
      <div className="onboarding-step-head">
        <div>
          <h2 className="onboarding-h2" ref={heading} tabIndex={-1}>
            Sign in to the CLIs Kumo runs on
          </h2>
          <p className="onboarding-p">Kumo runs each provider through its own CLI and sign-in, and never sees a password or key. One is enough to start.</p>
        </div>
        <button
          type="button"
          className="btn sm icon"
          aria-label="Check again"
          data-tooltip="Check again"
          data-tooltip-pos="left"
          aria-busy={rescanning || undefined}
          disabled={rescanning}
          onClick={() => void rescan()}
        >
          <IconRefresh />
        </button>
      </div>

      {accounts === null && loadError ? (
        <Callout
          tone="fail"
          action={
            <button type="button" className="btn sm" onClick={() => void rescan()}>
              Try again
            </button>
          }
        >
          Couldn't check your accounts: {loadError}
        </Callout>
      ) : accounts === null ? (
        <ul className="onboarding-list" aria-busy="true">
          <span className="sr-only" role="status">
            Looking for provider CLIs…
          </span>
          {[0, 1, 2].map((i) => (
            <li key={i} className="onboarding-row onboarding-row-skel" aria-hidden="true">
              <span className="acct-skel" style={{ width: i === 1 ? "30%" : "38%" }} />
              <span className="acct-skel" style={{ width: "16%" }} />
            </li>
          ))}
        </ul>
      ) : (
        <>
          <ul className="onboarding-list" data-part="onboarding-accounts">
            {list.map((a) => (
              <AccountRow key={a.provider} account={a} waiting={signingIn === a.provider} busy={signingIn !== null && signingIn !== a.provider} />
            ))}
          </ul>
          <p className="onboarding-note" data-tone={ready === 0 ? "warn" : undefined} role="status">
            {ready === 0
              ? "Nothing signed in yet. Kumo can't run a task without one; you can also sign in later in Settings › Accounts."
              : `${ready} ready to use. Sign in to more now or later, in Settings › Accounts.`}
          </p>
        </>
      )}
    </>
  );
}

function AccountRow({ account: a, waiting, busy }: { account: AccountStatus; waiting: boolean; busy: boolean }) {
  const status = !a.installed ? "idle" : a.signedIn === true ? "ok" : a.signedIn === null ? "warn" : "idle";
  return (
    <li className="onboarding-row" data-signed-in={String(a.signedIn)} data-installed={a.installed}>
      <StatusDot status={status} />
      <div className="onboarding-row-text">
        <div className="onboarding-row-name">
          {a.name}
          {a.plan && <Badge>{a.plan}</Badge>}
        </div>
        <div className="onboarding-row-detail">{waiting ? "Finish signing in in the terminal window…" : a.detail}</div>
      </div>
      {a.signedIn === true ? (
        <Badge tone="ok">
          <IconCheck />
          Signed in
        </Badge>
      ) : waiting ? (
        <span className="onboarding-waiting" role="status">
          <span className="wave" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Waiting
        </span>
      ) : a.installed && a.canSignIn ? (
        <button type="button" className="btn sm primary" disabled={busy} aria-label={`Sign in to ${a.name}`} onClick={() => void signIn(a.provider)}>
          Sign in
        </button>
      ) : (
        <span className="onboarding-row-state">{a.installed ? "Not signed in" : "Not installed"}</span>
      )}
    </li>
  );
}

// ── 2. roles ──

function RolesStep({ heading }: { heading: RefObject<HTMLHeadingElement | null> }) {
  const catalog = useStore((s) => s.catalog);
  const settings = useStore((s) => s.session?.settings ?? s.globalConfig?.settings ?? null);
  const catalogError = useStore((s) => s.loadErrors.catalog);
  const ids = useId();

  const pick = (target: ModelTarget | null, keys: { provider: string; model: string; effort: string }) => {
    if (!target) return;
    const effort = pickEffort(findModel(catalog, target.provider, target.model));
    void updateSettings({ [keys.provider]: target.provider, [keys.model]: target.model, ...(effort ? { [keys.effort]: effort } : {}) });
  };

  const lead = settings?.orchestratorProvider && settings.orchestratorModel ? { provider: settings.orchestratorProvider, model: settings.orchestratorModel } : null;
  const worker = settings?.workerProvider && settings.workerModel ? { provider: settings.workerProvider, model: settings.workerModel } : null;

  return (
    <>
      <div className="onboarding-step-head">
        <div>
          <h2 className="onboarding-h2" ref={heading} tabIndex={-1}>
            Pick who does what
          </h2>
          <p className="onboarding-p">
            The lead plans and hands out the work; the shared worker runs every role without a model of its own. Each role can get its own in Settings ›
            Roles.
          </p>
        </div>
      </div>

      {catalog === null && catalogError && (
        <Callout
          tone="fail"
          action={
            <button type="button" className="btn sm" onClick={() => void loadCatalog(true)}>
              Try again
            </button>
          }
        >
          Couldn't list the models: {catalogError}
        </Callout>
      )}

      <div className="onboarding-fields">
        <div className="onboarding-field">
          <div className="onboarding-field-text">
            <span className="form-label" id={`${ids}-lead`}>
              Lead
            </span>
            <span className="form-hint" id={`${ids}-lead-hint`}>
              Plans, decides and delegates. Pick your strongest model.
            </span>
          </div>
          <ModelPicker
            catalog={catalog}
            value={lead}
            need="lead"
            labelledBy={`${ids}-lead`}
            describedBy={`${ids}-lead-hint`}
            onChange={(t) => pick(t, { provider: "orchestratorProvider", model: "orchestratorModel", effort: "reasoningEffort" })}
          />
        </div>
        <div className="onboarding-field">
          <div className="onboarding-field-text">
            <span className="form-label" id={`${ids}-worker`}>
              Shared worker
            </span>
            <span className="form-hint" id={`${ids}-worker-hint`}>
              Edits files and runs tests. A fast model that can write works well.
            </span>
          </div>
          <ModelPicker
            catalog={catalog}
            value={worker}
            need="write"
            labelledBy={`${ids}-worker`}
            describedBy={`${ids}-worker-hint`}
            onChange={(t) => pick(t, { provider: "workerProvider", model: "workerModel", effort: "workerEffort" })}
          />
        </div>
      </div>
    </>
  );
}

// ── 3. project ──

function ProjectStep({
  heading,
  value,
  onChange,
  disabled,
  failed,
  onEdit,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  value: string;
  onChange: (path: string) => void;
  disabled: boolean;
  failed: boolean;
  onEdit: () => void;
}) {
  const ids = useId();
  const [picking, setPicking] = useState(false);

  const browse = async () => {
    setPicking(true);
    try {
      const folder = await window.kumo.app.pickFolder();
      if (folder) {
        onChange(folder);
        onEdit();
      }
    } finally {
      setPicking(false);
    }
  };

  const chosen = value.trim();

  return (
    <>
      <div className="onboarding-step-head">
        <div>
          <h2 className="onboarding-h2" ref={heading} tabIndex={-1}>
            Choose a project
          </h2>
          <p className="onboarding-p">Kumo works in one folder at a time: workers read and change files there, and nowhere else.</p>
        </div>
      </div>

      <button
        type="button"
        className="onboarding-folder"
        data-chosen={chosen ? true : undefined}
        data-part="onboarding-browse"
        disabled={disabled || picking}
        onClick={() => void browse()}
      >
        <span className="onboarding-folder-icon" aria-hidden="true">
          <IconFolder />
        </span>
        <span className="onboarding-folder-text">
          <span className="onboarding-folder-title">{chosen ? "Project folder" : picking ? "Choosing…" : "Choose a folder"}</span>
          <span className="onboarding-folder-path">{chosen || "Any folder: a repository, or an empty one to start fresh."}</span>
        </span>
        <span className="onboarding-folder-action">{chosen ? "Change" : "Browse"}</span>
      </button>

      <div className="form-field">
        <label className="form-label" htmlFor={`${ids}-path`}>
          Or type its path
        </label>
        <input
          id={`${ids}-path`}
          className="field"
          data-mono
          spellCheck={false}
          autoComplete="off"
          placeholder="C:\Projects\my-app"
          value={value}
          disabled={disabled}
          aria-invalid={failed || undefined}
          aria-describedby={failed ? `${ids}-error` : undefined}
          onChange={(e) => {
            onChange(e.target.value);
            onEdit();
          }}
        />
        {failed && (
          <span className="form-hint" data-tone="fail" id={`${ids}-error`} role="alert">
            Kumo couldn't open that folder. Check the path, or choose another.
          </span>
        )}
      </div>
    </>
  );
}
