/**
 * App state, built from engine events. The engine is the source of truth;
 * this store only shapes its events into what the window draws.
 */

import { useSyncExternalStore } from "react";
import type {
  Approval,
  Chat,
  KumoEvent,
  Message,
  Prefs,
  Project,
  Quotas,
  SessionSnapshot,
  Toast,
  ToolView,
  Turn,
  TurnOutcome,
} from "./types";

export interface State {
  phase: "loading" | "no-project" | "ready";
  prefs: Prefs | null;
  session: SessionSnapshot | null;
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  tools: Record<string, ToolView>;
  toolOrder: string[];
  approvals: Approval[];
  toasts: Toast[];
  busy: boolean;
  quotas: Quotas;
}

const MAX_TOOL_OUTPUT = 120_000;

let state: State = {
  phase: "loading",
  prefs: null,
  session: null,
  projects: [],
  chats: [],
  messages: [],
  tools: {},
  toolOrder: [],
  approvals: [],
  toasts: [],
  busy: false,
  quotas: { orchestrator: null, antigravity: null },
};

const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(state)
  );
}

const invoke = <T,>(command: string, args?: unknown) => window.kumo.invoke(command, args) as Promise<T>;

let toastSeq = 1;
export function toast(kind: Toast["kind"], text: string): void {
  const id = toastSeq++;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  if (kind !== "error") setTimeout(() => dismissToast(id), 6000);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

const messagesFromLog = (log: Turn[]): Message[] =>
  log.flatMap((turn, i) => [
    { id: `u${i}`, kind: "user", text: turn.prompt, turnId: null, streaming: false, thinking: false, failed: null, tools: [] },
    { id: `l${i}`, kind: "lead", text: turn.responseSummary || "", turnId: null, streaming: false, thinking: false, failed: null, tools: [] },
  ]);

/** Load the current chat's transcript and the chat list. */
export async function refreshChat(): Promise<void> {
  const session = state.session;
  if (!session) return;
  const [log, chats] = await Promise.all([
    invoke<Turn[]>("session.turnLog", { sessionId: session.id }),
    invoke<Chat[]>("session.listChats", { sessionId: session.id }),
  ]);
  setState({ messages: messagesFromLog(log), chats, tools: {}, toolOrder: [], approvals: [] });
}

async function refreshProjects(): Promise<void> {
  setState({ projects: await invoke<Project[]>("projects.list") });
}

/** Open a workspace: a new session there, or move the current one. */
export async function openWorkspace(workspace: string): Promise<void> {
  const current = state.session;
  const snapshot = current
    ? await invoke<SessionSnapshot>("session.setWorkspace", { sessionId: current.id, workspace })
    : await invoke<SessionSnapshot>("session.create", { workspace });
  setState({ session: snapshot, busy: snapshot.busy, quotas: snapshot.quotas, phase: "ready" });
  await savePrefs({ lastWorkspace: snapshot.workspace });
  await Promise.all([refreshChat(), refreshProjects()]);
}

export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const prefs = await invoke<Prefs>("prefs.set", { patch });
  setState({ prefs });
}

export async function boot(): Promise<void> {
  const [prefs, projects] = await Promise.all([invoke<Prefs>("prefs.get"), invoke<Project[]>("projects.list")]);
  setState({ prefs, projects });
  const known = new Set(projects.map((p) => p.path));
  const workspace = prefs.lastWorkspace && known.has(prefs.lastWorkspace) ? prefs.lastWorkspace : projects[0]?.path;
  if (!workspace) {
    setState({ phase: "no-project" });
    return;
  }
  try {
    await openWorkspace(workspace);
  } catch (err) {
    toast("error", `Couldn't open ${workspace}: ${(err as Error).message}`);
    setState({ phase: "no-project" });
  }
}

export async function send(prompt: string): Promise<void> {
  const session = state.session;
  if (!session || state.busy) return;
  // Busy at once, so a second Enter can't send before turn.started arrives;
  // session.send resolves when the turn is over.
  setState({ busy: true });
  try {
    const outcome = await invoke<TurnOutcome>("session.send", { sessionId: session.id, prompt });
    if (!outcome.ok && outcome.interrupted) toast("notice", "Turn interrupted.");
  } catch (err) {
    toast("error", (err as Error).message);
  } finally {
    setState({ busy: false });
  }
}

export const interrupt = () =>
  state.session && invoke("session.interrupt", { sessionId: state.session.id }).catch(() => {});

export async function resolveApproval(approvalId: string, approved: boolean): Promise<void> {
  if (!state.session) return;
  await invoke("session.resolveApproval", { sessionId: state.session.id, approvalId, approved });
}

export async function newChat(): Promise<void> {
  if (!state.session || state.busy) return;
  const snapshot = await invoke<SessionSnapshot>("session.newChat", { sessionId: state.session.id });
  setState({ session: snapshot });
  await refreshChat();
}

export async function openChat(chatId: string): Promise<void> {
  if (!state.session || state.busy || chatId === state.session.chatId) return;
  const { resumed } = await invoke<{ resumed: boolean }>("session.openChat", { sessionId: state.session.id, chatId });
  if (!resumed) toast("notice", "This chat continues in a fresh conversation; its provider can't resume the old one.");
}

export async function pickAndOpenFolder(): Promise<void> {
  const folder = await window.kumo.app.pickFolder();
  if (folder) await openWorkspace(folder);
}

export async function refreshQuotas(): Promise<void> {
  if (!state.session) return;
  setState({ quotas: await invoke<Quotas>("session.refreshQuotas", { sessionId: state.session.id }) });
}

// ── engine events ──

const updateLead = (turnId: string, fn: (m: Message) => Message) =>
  setState((s) => ({ messages: s.messages.map((m) => (m.kind === "lead" && m.turnId === turnId ? fn(m) : m)) }));

const updateTool = (toolId: string, fn: (t: ToolView) => ToolView) =>
  setState((s) => (s.tools[toolId] ? { tools: { ...s.tools, [toolId]: fn(s.tools[toolId]) } } : {}));

export function handleEvent(event: KumoEvent): void {
  if (state.session && event.sessionId !== state.session.id) return;
  switch (event.type) {
    case "turn.started":
      setState((s) => ({
        busy: true,
        messages: [
          ...s.messages,
          { id: `${event.turnId}-u`, kind: "user", text: event.prompt, turnId: event.turnId, streaming: false, thinking: false, failed: null, tools: [] },
          { id: `${event.turnId}-l`, kind: "lead", text: "", turnId: event.turnId, streaming: true, thinking: true, failed: null, tools: [] },
        ],
      }));
      break;
    case "turn.delta":
      updateLead(event.turnId, (m) => ({ ...m, text: m.text + event.text, thinking: false }));
      break;
    case "turn.reasoning":
      updateLead(event.turnId, (m) => ({ ...m, thinking: m.text === "" }));
      break;
    case "turn.completed":
      updateLead(event.turnId, (m) => ({ ...m, streaming: false, thinking: false }));
      setState({ busy: false });
      void refreshChatList();
      break;
    case "turn.failed":
      updateLead(event.turnId, (m) => ({ ...m, streaming: false, thinking: false, failed: event.reason }));
      setState({ busy: false });
      break;
    case "tool.started":
      setState((s) => ({
        tools: {
          ...s.tools,
          [event.toolId]: {
            toolId: event.toolId,
            turnId: event.turnId,
            name: event.name,
            task: event.task,
            model: event.model,
            effort: event.effort,
            status: "running",
            startedAt: event.startedAt,
            elapsedMs: null,
            output: "",
          },
        },
        toolOrder: [...s.toolOrder.filter((id) => id !== event.toolId), event.toolId],
        messages: event.turnId
          ? s.messages.map((m) => (m.kind === "lead" && m.turnId === event.turnId ? { ...m, tools: [...m.tools, event.toolId] } : m))
          : s.messages,
      }));
      break;
    case "tool.output":
      updateTool(event.toolId, (t) => ({ ...t, output: (t.output + event.text).slice(-MAX_TOOL_OUTPUT) }));
      break;
    case "tool.completed":
      updateTool(event.toolId, (t) => ({ ...t, status: event.ok ? "done" : "failed", elapsedMs: event.elapsedMs }));
      break;
    case "approval.requested":
      setState((s) => ({
        approvals: [...s.approvals, { approvalId: event.approvalId, kind: event.kind, tool: event.tool, preview: event.preview }],
      }));
      break;
    case "approval.resolved":
      setState((s) => ({ approvals: s.approvals.filter((a) => a.approvalId !== event.approvalId) }));
      break;
    case "quota.updated":
      setState({ quotas: { orchestrator: event.orchestrator, antigravity: event.antigravity } });
      break;
    case "settings.changed":
      setState((s) => (s.session ? { session: { ...s.session, settings: event.settings } } : {}));
      break;
    case "chat.changed":
      setState((s) => (s.session ? { session: { ...s.session, chatId: event.chatId, workspace: event.workspace } } : {}));
      void refreshChat();
      break;
    case "session.warning":
      toast("warning", event.message);
      break;
    case "session.notice":
      toast("notice", event.message);
      break;
    case "session.error":
      toast("error", event.message);
      break;
    default:
      break;
  }
}

async function refreshChatList(): Promise<void> {
  if (!state.session) return;
  setState({ chats: await invoke<Chat[]>("session.listChats", { sessionId: state.session.id }) });
}
