import { Fragment } from "react";
import { basename, providerLabel, sameDir } from "../lib";
import { openChat, openWorkspace, pickAndOpenFolder, toast, useStore } from "../store";
import type { Quotas, SessionSettings } from "../types";
import { IconFolder } from "./icons";

/** One usage window: the share left (0-100) and when it resets. */
export type MeterWindow = { left: number; reset: string | null };
/** One bar per provider or Antigravity pool, with its 5-hour and weekly windows layered on the same track. */
export type Meter = { label: string; fiveHour: MeterWindow | null; weekly: MeterWindow | null };
type WindowKey = "fiveHour" | "weekly";

const WINDOW_KEYS: WindowKey[] = ["fiveHour", "weekly"];
const WINDOW_NAME: Record<WindowKey, string> = { fiveHour: "5-hour", weekly: "Weekly" };
const WINDOW_SHORT: Record<WindowKey, string> = { fiveHour: "5h", weekly: "weekly" };

const BUILTIN_ROLE_KEYS = ["scout", "builder", "tester", "researcher", "reviewer", "designer"] as const;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v && v !== "N/A" ? v : null);
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
const normProvider = (p: string | null | undefined): string => {
  const v = (p ?? "").trim().toLowerCase();
  return v === "agy" ? "antigravity" : v;
};
const isClaudeOrGpt = (model: string | null | undefined): boolean =>
  /claude|gpt|anthropic/i.test(String(model ?? ""));

function activeTargets(settings: SessionSettings | undefined): Array<{ provider: string; model: string }> {
  if (!settings) return [];
  const out: Array<{ provider: string; model: string }> = [];
  const leadProvider = normProvider(settings.orchestratorProvider);
  if (leadProvider) out.push({ provider: leadProvider, model: settings.orchestratorModel || "" });
  const workerProvider = normProvider(settings.workerProvider);
  if (workerProvider) out.push({ provider: workerProvider, model: settings.workerModel || "" });
  for (const key of BUILTIN_ROLE_KEYS) {
    const role = settings.roles?.[key];
    if (role?.model) out.push({ provider: normProvider(role.provider || workerProvider), model: role.model });
  }
  for (const custom of settings.roles?.custom ?? []) {
    const p = normProvider(custom.provider || workerProvider);
    const m = custom.model || (p === workerProvider ? settings.workerModel : "") || "";
    if (p) out.push({ provider: p, model: m });
  }
  return out;
}

/** Windows up to 6 hours are the 5-hour limit; anything longer sits in the weekly slot. */
function windowKey(windowMinutes: unknown, fallback: WindowKey): WindowKey {
  const mins = num(windowMinutes);
  if (!mins) return fallback;
  return mins <= 360 ? "fiveHour" : "weekly";
}

/** Two windows that land in the same slot keep the tighter one. */
function place(meter: Meter, key: WindowKey, win: MeterWindow): void {
  const current = meter[key];
  if (!current || win.left < current.left) meter[key] = win;
}

/** An Antigravity window, which already reports the share left. */
function remaining(percent: unknown, reset: unknown): MeterWindow | null {
  const left = num(percent);
  return left === null ? null : { left: clamp(left), reset: str(reset) };
}

/** Orchestrator/provider limits report the share used; Antigravity reports what's left. */
export function meters(quotas: Quotas, settings: SessionSettings | undefined): Meter[] {
  const out: Meter[] = [];
  const targets = activeTargets(settings);
  const leadProvider = normProvider(settings?.orchestratorProvider);

  const directProviders: string[] = [];
  const addProvider = (p: string) => {
    if (p && p !== "antigravity" && !directProviders.includes(p)) directProviders.push(p);
  };
  if (leadProvider) addProvider(leadProvider);
  for (const t of targets) addProvider(t.provider);
  if (directProviders.length === 0 && quotas.orchestrator) directProviders.push("lead");

  for (const p of directProviders) {
    const limits =
      quotas.providers?.[p] ??
      (p === leadProvider || p === "lead" ? quotas.orchestrator : null);
    const used = num(limits?.usedPercent);
    if (!limits || used === null) continue;
    const meter: Meter = { label: (p === "lead" ? "" : providerLabel(p)) || "Lead", fiveHour: null, weekly: null };
    place(meter, windowKey(limits.windowMinutes, "fiveHour"), {
      left: clamp(100 - used),
      reset: str(limits.resetFormatted),
    });
    const secondary = limits.secondary as Record<string, unknown> | null | undefined;
    const usedLater = num(secondary?.usedPercent);
    if (secondary && usedLater !== null) {
      place(meter, windowKey(secondary.windowMinutes, "weekly"), {
        left: clamp(100 - usedLater),
        reset: str(secondary.resetFormatted),
      });
    }
    out.push(meter);
  }

  const a = quotas.antigravity;
  const agyTargets = targets.filter((t) => t.provider === "antigravity");
  const usesAgy = agyTargets.length > 0 || (!settings && Boolean(a));
  if (a && usesAgy) {
    const pool = (label: string, fiveHour: MeterWindow | null, weekly: MeterWindow | null) => {
      if (fiveHour || weekly) out.push({ label, fiveHour, weekly });
    };
    const usesGeminiFamily = agyTargets.length === 0 || agyTargets.some((t) => !isClaudeOrGpt(t.model));
    if (usesGeminiFamily) {
      pool(
        "Gemini",
        remaining(a.gemini5HourPercent, a.gemini5HourResetFormatted),
        remaining(a.geminiWeeklyPercent, a.geminiWeeklyResetFormatted)
      );
    }
    pool(
      "Gemini 4 Argon",
      remaining(a.geminiArgon5HourPercent, a.geminiArgon5HourResetFormatted),
      remaining(a.geminiArgonWeeklyPercent, a.geminiArgonWeeklyResetFormatted)
    );
    if (agyTargets.some((t) => isClaudeOrGpt(t.model))) {
      pool(
        "Claude/GPT",
        remaining(a.claudeGpt5HourPercent, a.claudeGpt5HourResetFormatted),
        remaining(a.claudeGptWeeklyPercent, a.claudeGptWeeklyResetFormatted)
      );
    }
  }
  return out;
}

const windowsOf = (row: Meter): Array<[WindowKey, MeterWindow]> =>
  WINDOW_KEYS.flatMap((key): Array<[WindowKey, MeterWindow]> => {
    const win = row[key];
    return win ? [[key, win]] : [];
  });

/** "5-hour: 75% left, resets in 3h · Weekly: 41% left, resets Thu 09:00" */
const describe = (row: Meter): string =>
  windowsOf(row)
    .map(([key, win]) => `${WINDOW_NAME[key]}: ${win.left}% left${win.reset ? `, resets ${win.reset}` : ""}`)
    .join(" · ");

/** The shorter fill draws on top so both stay visible; on a tie the weekly one does. */
function topWindow(row: Meter): WindowKey | null {
  if (!row.fiveHour || !row.weekly) return null;
  return row.fiveHour.left < row.weekly.left ? "fiveHour" : "weekly";
}

/**
 * A reset short enough for the line under the bar. Providers report "in 3h 40m (Oct 25, 03:40 PM)":
 * the 5-hour window keeps the countdown, the weekly one the date. Other shapes show as given.
 */
function shortReset(key: WindowKey, reset: string): string {
  const both = /^in (.+?) \((.+)\)$/.exec(reset);
  if (both) return key === "fiveHour" ? `in ${both[1]}` : both[2];
  if (/^reset due now\b/i.test(reset)) return "due now";
  return reset;
}

function MeterRow({ row }: { row: Meter }) {
  const windows = windowsOf(row);
  const top = topWindow(row);
  const resets = windows.filter((entry): entry is [WindowKey, MeterWindow & { reset: string }] => Boolean(entry[1].reset));
  return (
    <div className="meter" data-part="meter" title={describe(row)}>
      <div className="meter-row">
        <span className="meter-label">{row.label}</span>
        <span className="meter-values" aria-hidden="true">
          {windows.map(([key, win]) => (
            <span key={key} className="meter-value" data-window={key}>
              {win.left}%
            </span>
          ))}
        </span>
      </div>
      <div className="meter-track">
        {windows.map(([key, win]) => (
          <div
            key={key}
            className="meter-fill"
            data-window={key}
            data-top={key === top || undefined}
            role="meter"
            aria-label={`${row.label} ${WINDOW_NAME[key].toLowerCase()} usage left`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={win.left}
            aria-valuetext={`${win.left}% left${win.reset ? `, resets ${win.reset}` : ""}`}
            style={{ width: `${win.left}%` }}
          />
        ))}
      </div>
      {resets.length > 0 && (
        <div className="meter-detail" aria-hidden="true">
          {resets.map(([key, win]) => (
            <span key={key} className="meter-reset" data-window={key}>
              {shortReset(key, win.reset)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Meters() {
  const quotas = useStore((s) => s.quotas);
  const settings = useStore((s) => s.session?.settings);
  const rows = meters(quotas, settings);
  const shown = WINDOW_KEYS.filter((key) => rows.some((row) => row[key]));
  return (
    <>
      <div className="sidebar-section usage-head">
        <span>Usage</span>
        {shown.length > 0 && (
          <span className="meter-legend" aria-hidden="true">
            {shown.map((key) => (
              <span key={key} className="meter-key" data-window={key}>
                {WINDOW_SHORT[key]}
              </span>
            ))}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="meter small">Usage shows here after the first turn.</div>
      ) : (
        <div className="meters" data-part="meters">
          {rows.map((row, i) => (
            <MeterRow key={`${i}:${row.label}`} row={row} />
          ))}
        </div>
      )}
    </>
  );
}

export function Sidebar() {
  const projects = useStore((s) => s.projects);
  const session = useStore((s) => s.session);
  const chats = useStore((s) => s.chats);
  const busy = useStore((s) => s.busy);

  const list =
    session && !projects.some((p) => sameDir(p.path, session.workspace))
      ? [{ path: session.workspace, name: basename(session.workspace) }, ...projects]
      : projects;
  const chatListed = chats.some((c) => c.id === session?.chatId);

  const open = (path: string) => openWorkspace(path).catch((err: Error) => toast("error", err.message));

  return (
    <nav className="sidebar glass" data-part="sidebar" aria-label="Projects and chats">
      <div className="side-scroll">
        <div className="sidebar-section">Projects</div>
        {list.map((project) => {
          const current = sameDir(project.path, session?.workspace);
          return (
            <Fragment key={project.path}>
              <button
                className="side-item project"
                aria-current={current}
                title={project.path}
                disabled={busy && !current}
                onClick={() => !current && void open(project.path)}
              >
                {project.name}
              </button>
              {current && !chatListed && (
                <button className="side-item chat" aria-current="true">
                  New chat
                </button>
              )}
              {current &&
                chats.map((chat) => (
                  <button
                    key={chat.id}
                    className="side-item chat"
                    aria-current={chat.id === session?.chatId}
                    title={chat.title}
                    disabled={busy}
                    onClick={() => void openChat(chat.id).catch((err: Error) => toast("error", err.message))}
                  >
                    {chat.title || "Untitled chat"}
                  </button>
                ))}
            </Fragment>
          );
        })}
        <button className="side-item action" onClick={() => void pickAndOpenFolder().catch((err: Error) => toast("error", err.message))}>
          <IconFolder /> Open folder…
        </button>
      </div>
      <div className="hr" />
      <Meters />
    </nav>
  );
}
