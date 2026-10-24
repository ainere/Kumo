import { Fragment } from "react";
import { basename, providerLabel, sameDir } from "../lib";
import { openChat, openWorkspace, pickAndOpenFolder, toast, useStore } from "../store";
import type { Quotas } from "../types";
import { IconFolder } from "./icons";

type Meter = { label: string; left: number; detail: string | null };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v && v !== "N/A" ? v : null);
const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

/** Orchestrator limits report the share used; Antigravity reports what's left. */
function meters(quotas: Quotas, provider: string | undefined): Meter[] {
  const out: Meter[] = [];
  const o = quotas.orchestrator;
  const used = num(o?.usedPercent);
  if (o && used !== null) {
    out.push({ label: providerLabel(provider) || "Lead", left: clamp(100 - used), detail: str(o.resetFormatted) });
    const secondary = o.secondary as Record<string, unknown> | null | undefined;
    const usedLater = num(secondary?.usedPercent);
    if (secondary && usedLater !== null) {
      out.push({ label: `${providerLabel(provider)} weekly`, left: clamp(100 - usedLater), detail: str(secondary.resetFormatted) });
    }
  }
  const a = quotas.antigravity;
  const gemini = num(a?.geminiWeeklyPercent);
  if (a && gemini !== null) out.push({ label: "Gemini weekly", left: clamp(gemini), detail: str(a.geminiWeeklyResetFormatted) });
  const claudeGpt = num(a?.claudeGptWeeklyPercent);
  if (a && claudeGpt !== null) {
    out.push({ label: "Claude/GPT weekly", left: clamp(claudeGpt), detail: str(a.claudeGptWeeklyResetFormatted) });
  }
  return out;
}

function Meters() {
  const quotas = useStore((s) => s.quotas);
  const provider = useStore((s) => s.session?.settings.orchestratorProvider);
  const rows = meters(quotas, provider);
  if (rows.length === 0) return <div className="meter small">Usage shows here after the first turn.</div>;
  return (
    <>
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
      <div className="sidebar-section">Usage</div>
      <Meters />
    </nav>
  );
}
