import { Fragment } from "react";
import { basename, providerLabel, sameDir } from "../lib";
import { openChat, openWorkspace, pickAndOpenFolder, toast, useStore } from "../store";
import type { Quotas, SessionSettings } from "../types";
import { IconFolder } from "./icons";

type Meter = { label: string; left: number; detail: string | null };

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

function windowSuffix(windowMinutes: unknown): string {
  const mins = num(windowMinutes);
  if (mins === null || mins <= 360) return "5h";
  if (mins <= 11520) return "weekly";
  return "monthly";
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
    const name = (p === "lead" ? "" : providerLabel(p)) || "Lead";
    const primarySuffix = windowSuffix(limits.windowMinutes);
    out.push({
      label: `${name} ${primarySuffix}`,
      left: clamp(100 - used),
      detail: str(limits.resetFormatted),
    });
    const secondary = limits.secondary as Record<string, unknown> | null | undefined;
    const usedLater = num(secondary?.usedPercent);
    if (secondary && usedLater !== null) {
      const secondarySuffix = secondary.windowMinutes ? windowSuffix(secondary.windowMinutes) : "weekly";
      out.push({
        label: `${name} ${secondarySuffix}`,
        left: clamp(100 - usedLater),
        detail: str(secondary.resetFormatted),
      });
    }
  }

  const a = quotas.antigravity;
  const agyTargets = targets.filter((t) => t.provider === "antigravity");
  const usesAgy = agyTargets.length > 0 || (!settings && Boolean(a));
  if (a && usesAgy) {
    const usesGeminiFamily = agyTargets.length === 0 || agyTargets.some((t) => !isClaudeOrGpt(t.model));
    const gemini = num(a.geminiWeeklyPercent);
    if (usesGeminiFamily && gemini !== null) {
      out.push({ label: "Gemini weekly", left: clamp(gemini), detail: str(a.geminiWeeklyResetFormatted) });
    }
    const argon = num(a.geminiArgonWeeklyPercent);
    if (argon !== null) {
      out.push({ label: "Gemini 4 Argon", left: clamp(argon), detail: str(a.geminiArgonWeeklyResetFormatted) });
    }
    const usesAgyClaudeGpt = agyTargets.some((t) => isClaudeOrGpt(t.model));
    const claudeGpt = num(a.claudeGptWeeklyPercent);
    if (usesAgyClaudeGpt && claudeGpt !== null) {
      out.push({ label: "Claude/GPT weekly", left: clamp(claudeGpt), detail: str(a.claudeGptWeeklyResetFormatted) });
    }
  }
  return out;
}

function Meters() {
  const quotas = useStore((s) => s.quotas);
  const settings = useStore((s) => s.session?.settings);
  const rows = meters(quotas, settings);
  if (rows.length === 0) return <div className="meter small">Usage shows here after the first turn.</div>;
  return (
    <div className="meters" data-part="meters">
      {rows.map((row) => (
        <div className="meter" key={row.label}>
          <div className="meter-row">
            <span>{row.label}</span>
            <span>{row.left}% left</span>
          </div>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${row.left}%` }} />
          </div>
          {row.detail && <div className="meter-detail">resets {row.detail}</div>}
        </div>
      ))}
    </div>
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
      <div className="sidebar-section">Usage</div>
      <Meters />
    </nav>
  );
}
