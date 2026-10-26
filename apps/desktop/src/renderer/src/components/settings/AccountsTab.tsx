/**
 * Settings › Accounts: a card per provider, grouped as subscriptions, direct
 * APIs and local models. Each says whether it is signed in (or has its key,
 * or is running), with its plan, version and usage, and the one action that
 * changes that. Keys are never shown or asked for: only whether the variable
 * is set.
 */

import "../../styles/settings-accounts.css";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { providerLabel } from "../../lib";
import {
  getState,
  invoke,
  loadAccounts,
  loadGlobalConfig,
  refreshQuotas,
  signIn,
  signOut,
  toastFailure,
  useStore,
} from "../../store";
import type { AccountKind, AccountStatus, EndpointTest } from "../../types";
import { IconRefresh } from "../icons";
import { MeterRow, meters, type Meter } from "../Sidebar";
import { Badge, Callout, Modal, Note, PageHeader, Section, StatusDot, type StatusKind } from "./controls";

const GROUPS: ReadonlyArray<{ kind: AccountKind; label: string; hint: string }> = [
  {
    kind: "subscription",
    label: "Subscriptions",
    hint: "Kumo runs on each CLI's own sign-in. Sign in opens that CLI's login in a terminal window.",
  },
  {
    kind: "api",
    label: "Direct API",
    hint: "Keys come from environment variables, read when Kumo starts. Kumo never stores them, shows them or asks for them.",
  },
  { kind: "local", label: "Local", hint: "Models served on this computer." },
];

/** Signed in first, then can't tell, not signed in, not installed. */
const rank = (a: AccountStatus): number => (!a.installed ? 3 : a.signedIn === true ? 0 : a.signedIn === null ? 1 : 2);

// ── page ──

export function AccountsTab() {
  const accounts = useStore((s) => s.accounts);
  const [loading, setLoading] = useState(accounts === null);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmOut, setConfirmOut] = useState<AccountStatus | null>(null);
  // The sign-in Kumo opened and is watching for; the store stops watching when Settings closes.
  const signingIn = useStore((s) => s.signingIn);
  const loadError = useStore((s) => s.loadErrors.accounts);

  const settle = () => setFailed(getState().accounts === null);

  useEffect(() => {
    let live = true;
    void loadAccounts(false).finally(() => {
      if (!live) return;
      setLoading(false);
      settle();
    });
    if (getState().globalConfig === null) void loadGlobalConfig();
    return () => {
      live = false;
    };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setFailed(false);
    if (getState().accounts === null) setLoading(true);
    await Promise.all([loadAccounts(true), refreshQuotas().catch(() => {})]);
    setRefreshing(false);
    setLoading(false);
    settle();
  };

  const busy = loading || refreshing;

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Sign in to the providers Kumo runs on, and see which API keys it can use."
        actions={
          <button
            type="button"
            className="btn acct-refresh"
            data-part="accounts-refresh"
            data-busy={busy || undefined}
            aria-busy={busy || undefined}
            disabled={busy}
            onClick={() => void refresh()}
          >
            <IconRefresh />
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        }
      />

      {accounts === null ? (
        loading ? (
          <AccountsSkeleton />
        ) : failed ? (
          <Callout
            tone="fail"
            part="accounts-error"
            action={
              <button type="button" className="btn sm" onClick={() => void refresh()}>
                Try again
              </button>
            }
          >
            Couldn't read your accounts{loadError ? `: ${loadError}` : "."}
          </Callout>
        ) : (
          <AccountsSkeleton />
        )
      ) : accounts.length === 0 ? (
        <Note>No providers to show.</Note>
      ) : (
        GROUPS.map(({ kind, label, hint }) => {
          const list = accounts.filter((a) => a.kind === kind).sort((a, b) => rank(a) - rank(b));
          if (list.length === 0) return null;
          return (
            <Section
              key={kind}
              label={label}
              hint={hint}
              plain
              part={`accounts-${kind}`}
              actions={kind === "subscription" ? <MeterLegend accounts={list} /> : undefined}
            >
              <div className="acct-list">
                {list.map((account) => (
                  <AccountCard
                    key={account.provider}
                    account={account}
                    waiting={signingIn === account.provider}
                    onSignIn={() => void signIn(account.provider)}
                    onSignOut={() => setConfirmOut(account)}
                  />
                ))}
              </div>
            </Section>
          );
        })
      )}

      {confirmOut && <SignOutDialog account={confirmOut} onClose={() => setConfirmOut(null)} />}
    </>
  );
}

function AccountsSkeleton() {
  return (
    <div className="acct-skeleton" aria-busy="true" data-part="accounts-loading">
      <span className="sr-only" role="status">
        Checking your accounts…
      </span>
      <div className="acct-skel acct-skel-label" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="acct-card acct-skel-card" aria-hidden="true">
          <div className="acct-skel" style={{ width: i === 1 ? "28%" : "36%" }} />
          <div className="acct-skel" style={{ width: i === 2 ? "44%" : "58%" }} />
        </div>
      ))}
    </div>
  );
}

// ── usage ──

const WINDOWS = [
  ["fiveHour", "5h"],
  ["weekly", "weekly"],
  ["monthly", "monthly"],
] as const;

/** Antigravity's meters are its model pools, not its own name. */
const AGY_POOLS = new Set(["Gemini", "Gemini 4 Argon", "Claude/GPT"]);

/** The session's usage bars that belong to this provider (allProviders=true so accounts page shows every known provider). */
function useProviderMeters(provider: string): Meter[] {
  const quotas = useStore((s) => s.quotas);
  const settings = useStore((s) => s.session?.settings);
  const rows = meters(quotas, settings, true);
  if (provider === "antigravity") return rows.filter((r) => AGY_POOLS.has(r.label));
  const label = providerLabel(provider);
  return rows.filter((r) => r.label === label && !AGY_POOLS.has(r.label));
}

/** The windows' colors, once for the group, when any card has a bar. */
function MeterLegend({ accounts }: { accounts: AccountStatus[] }) {
  const quotas = useStore((s) => s.quotas);
  const settings = useStore((s) => s.session?.settings);
  const rows = meters(quotas, settings, true);
  const labels = new Set(accounts.map((a) => providerLabel(a.provider)));
  const mine = rows.filter((r) => labels.has(r.label) || AGY_POOLS.has(r.label));
  const shown = WINDOWS.filter(([key]) => mine.some((r) => r[key]));
  if (shown.length === 0) return null;
  return (
    <span className="meter-legend acct-legend" aria-hidden="true">
      {shown.map(([key, text]) => (
        <span key={key} className="meter-key" data-window={key}>
          {text} left
        </span>
      ))}
    </span>
  );
}

// ── a provider ──

type State = { status: StatusKind; text: ReactNode };

function stateOf(a: AccountStatus): State {
  if (!a.installed) return { status: "idle", text: "Not installed" };
  if (a.kind === "api") {
    if (a.provider === "compat-api") {
      if (a.signedIn) return { status: "ok", text: "Endpoint set" };
      return a.baseUrl ? { status: "fail", text: "Base URL not allowed" } : { status: "idle", text: "No base URL" };
    }
    const name = <code className="acct-code">{a.envVar ?? "The key"}</code>;
    return a.signedIn ? { status: "ok", text: <>{name} is set</> } : { status: "idle", text: <>{name} is not set</> };
  }
  if (a.kind === "local") {
    if (a.signedIn === null) return { status: "warn", text: "Can't tell" };
    return a.signedIn ? { status: "ok", text: "Running" } : { status: "idle", text: "Not running" };
  }
  if (a.signedIn === null) return { status: "warn", text: "Can't tell" };
  if (!a.signedIn) return { status: "idle", text: "Not signed in" };
  return { status: "ok", text: a.account ? <>Signed in as {a.account}</> : "Signed in" };
}

/** The line under the state: the engine's detail, or for a missing key, how to add one. */
function detailOf(a: AccountStatus): ReactNode {
  if (a.kind === "api" && a.provider !== "compat-api") {
    if (a.signedIn) return null;
    return (
      <>
        Set <code className="acct-code">{a.envVar ?? "the key variable"}</code> in your environment — Kumo reads keys from the environment and
        never stores them.
      </>
    );
  }
  return a.detail || null;
}

function AccountCard({
  account: a,
  waiting,
  onSignIn,
  onSignOut,
}: {
  account: AccountStatus;
  waiting: boolean;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  const headingId = useId();
  const state = stateOf(a);
  const detail = detailOf(a);
  const rows = useProviderMeters(a.provider);
  const showMeters = a.installed && a.signedIn === true && rows.length > 0;
  const actionable = a.installed && a.kind === "subscription";

  return (
    <article
      className="acct-card"
      aria-labelledby={headingId}
      data-part="account-card"
      data-provider={a.provider}
      data-installed={a.installed}
      data-signed-in={String(a.signedIn)}
    >
      <div className="acct-main">
        <div className="acct-id">
          <div className="acct-title">
            <h3 className="acct-name" id={headingId}>
              {a.name}
            </h3>
            {a.plan && <Badge>{a.plan}</Badge>}
            {a.version && (
              <Badge mono title="Version">
                {a.version}
              </Badge>
            )}
          </div>
          {waiting ? (
            <div className="acct-state" data-part="account-waiting" role="status">
              <span className="wave" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Waiting for the terminal…
            </div>
          ) : (
            <div className="acct-state" data-status={state.status}>
              <StatusDot status={state.status} />
              <span>{state.text}</span>
            </div>
          )}
          {detail && <div className="acct-detail">{detail}</div>}
        </div>
        {actionable && (a.canSignIn || a.canSignOut) && (
          <div className="acct-actions">
            {a.canSignIn && (
              <button
                type="button"
                className={a.signedIn === false ? "btn sm primary" : "btn sm"}
                data-part="account-sign-in"
                disabled={waiting}
                aria-label={`${a.signedIn ? "Switch account" : "Sign in"} — ${a.name}`}
                onClick={onSignIn}
              >
                {waiting ? "Waiting…" : a.signedIn ? "Switch account" : "Sign in"}
              </button>
            )}
            {a.canSignOut && (
              <button
                type="button"
                className="btn sm"
                data-part="account-sign-out"
                aria-label={`Sign out — ${a.name}`}
                onClick={onSignOut}
              >
                Sign out
              </button>
            )}
          </div>
        )}
      </div>

      {showMeters && (
        <div className="acct-meters" data-part="account-meters" data-count={rows.length}>
          {rows.map((row, i) => (
            <MeterRow key={`${i}:${row.label}`} row={row} />
          ))}
        </div>
      )}

      {a.installed && a.provider === "compat-api" && <CompatEndpoint account={a} />}
      {a.installed && a.provider === "ollama" && <OllamaEndpoint account={a} />}
    </article>
  );
}

// ── endpoints ──

/** What the engine accepts (isSafeBaseUrl): https, or plain http to this computer; no credentials. */
function baseUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "That isn't a full URL. Include https://.";
  }
  if (url.username || url.password) return "Leave the user name and password out of the URL.";
  if (url.protocol === "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1" || host === "::1")) return null;
  return "Use https, or plain http to localhost.";
}

const PREVIEW_MODELS = 4;

type Test = { phase: "idle" } | { phase: "testing" } | { phase: "done"; result: EndpointTest };

/** "Test connection" and what it found. */
function useEndpointTest(provider: "compat-api" | "ollama") {
  const [test, setTest] = useState<Test>({ phase: "idle" });
  const run = useRef(0);
  const start = async (baseUrl?: string) => {
    const mine = ++run.current;
    setTest({ phase: "testing" });
    let result: EndpointTest;
    try {
      result = (await window.kumo.invoke("accounts.testEndpoint", baseUrl ? { provider, baseUrl } : { provider })) as EndpointTest;
    } catch (err) {
      result = { ok: false, detail: err instanceof Error ? err.message : String(err), models: [] };
    }
    if (run.current === mine) setTest({ phase: "done", result });
  };
  const reset = () => {
    run.current++;
    setTest({ phase: "idle" });
  };
  return { test, start, reset };
}

function TestButton({ test, onClick, disabled = false, name }: { test: Test; onClick: () => void; disabled?: boolean; name: string }) {
  const testing = test.phase === "testing";
  return (
    <button
      type="button"
      className="btn sm"
      data-part="endpoint-test"
      aria-busy={testing || undefined}
      aria-label={`Test connection — ${name}`}
      disabled={disabled || testing}
      onClick={onClick}
    >
      {testing ? "Testing…" : "Test connection"}
    </button>
  );
}

function TestResult({ test }: { test: Test }) {
  // Always in the tree, so the result is announced when it lands.
  return (
    <div className="acct-test" role="status" aria-live="polite" data-part="endpoint-result" data-phase={test.phase}>
      {test.phase === "done" && (
        <>
          <div className="acct-test-line" data-ok={test.result.ok}>
            <StatusDot status={test.result.ok ? "ok" : "fail"} />
            <span>{test.result.detail}</span>
          </div>
          {test.result.models.length > 0 && (
            <div className="acct-test-models" aria-label="Models it lists">
              {test.result.models.slice(0, PREVIEW_MODELS).map((id) => (
                <Badge key={id} mono>
                  {id}
                </Badge>
              ))}
              {test.result.models.length > PREVIEW_MODELS && (
                <span className="acct-test-more">+{test.result.models.length - PREVIEW_MODELS} more</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const SAVED_FLASH_MS = 2400;

function CompatEndpoint({ account }: { account: AccountStatus }) {
  const saved = useStore((s) => s.globalConfig?.compatBaseUrl ?? null);
  const [draft, setDraft] = useState(saved ?? "");
  const [flash, setFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const { test, start, reset } = useEndpointTest("compat-api");
  const inputId = useId();
  const hintId = useId();

  // A saved value that changes elsewhere replaces an untouched field.
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (saved !== null && (lastSaved.current === null || draft === (lastSaved.current ?? ""))) setDraft(saved);
    lastSaved.current = saved;
  }, [saved]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(false), SAVED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const value = draft.trim();
  const problem = baseUrlProblem(draft);
  const dirty = saved !== null && value !== saved.trim();
  // The URL in use when none is saved: COMPAT_BASE_URL from the environment.
  const fromEnv = saved === "" && !value && account.baseUrl ? account.baseUrl : null;

  const commit = async () => {
    if (!dirty || problem || saving) return;
    setSaving(true);
    try {
      // Base URLs are saved defaults, not session settings: config.update takes them.
      await invoke("config.update", { patch: { compatBaseUrl: value } });
      setDraft(value);
      setFlash(true);
      await loadGlobalConfig();
      void loadAccounts(true);
    } catch (err) {
      toastFailure(err);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape" && dirty) {
      // Esc puts the saved value back; on an untouched field it leaves Settings as usual.
      e.preventDefault();
      setDraft(saved ?? "");
      reset();
    }
  };

  const hint: ReactNode =
    problem && value ? (
      <>Not saved. {problem}</>
    ) : flash ? (
      "Saved."
    ) : fromEnv ? (
      <>
        Using <code className="acct-code">COMPAT_BASE_URL</code> from your environment: <code className="acct-code">{fromEnv}</code>. A URL here
        takes its place.
      </>
    ) : (
      "https, or plain http to localhost. Saved when you press Enter or leave the field."
    );

  return (
    <div className="acct-extra" data-part="compat-endpoint">
      <label className="acct-field-label" htmlFor={inputId}>
        Base URL
      </label>
      <div className="acct-field-row">
        <input
          id={inputId}
          className="acct-input"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          placeholder={fromEnv ?? "https://api.example.com/v1"}
          value={draft}
          disabled={saved === null}
          aria-describedby={hintId}
          aria-invalid={problem && value ? true : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            if (test.phase !== "idle") reset();
          }}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
        />
        <TestButton test={test} name={account.name} disabled={Boolean(problem && value)} onClick={() => void start(value || undefined)} />
      </div>
      <div className="acct-field-hint" id={hintId} data-tone={problem && value ? "warn" : flash ? "ok" : undefined}>
        {hint}
      </div>
      <TestResult test={test} />
    </div>
  );
}

function OllamaEndpoint({ account }: { account: AccountStatus }) {
  const { test, start } = useEndpointTest("ollama");
  return (
    <div className="acct-extra" data-part="ollama-endpoint">
      <div className="acct-field-row">
        <div className="acct-host">
          <span className="acct-field-label">Host</span>
          <code className="acct-host-url">{account.baseUrl ?? "Not a valid address"}</code>
          <span className="acct-field-hint">From OLLAMA_HOST, or Ollama's default when it isn't set.</span>
        </div>
        <TestButton test={test} name={account.name} onClick={() => void start()} />
      </div>
      <TestResult test={test} />
    </div>
  );
}

// ── sign out ──

function SignOutDialog({ account, onClose }: { account: AccountStatus; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = async () => {
    setBusy(true);
    await signOut(account.provider);
    onClose();
  };
  return (
    <Modal
      title={`Sign out of ${account.name}?`}
      part="sign-out-dialog"
      initialFocus={cancel}
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <>
          <button ref={cancel} type="button" className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" data-part="sign-out-confirm" disabled={busy} onClick={() => void confirm()}>
            {busy ? "Signing out…" : "Sign out"}
          </button>
        </>
      }
    >
      <p>
        This signs the {account.name} CLI out everywhere on this computer, not just in Kumo
        {account.account ? (
          <>
            {" "}
            (<span className="acct-modal-account">{account.account}</span>)
          </>
        ) : null}
        .
      </p>
      <p className="muted">Roles that run on it stop working until you sign in again.</p>
    </Modal>
  );
}
