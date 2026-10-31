/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * App state, built from engine events. The engine is the source of truth;
 * this store only shapes its events into what the window draws.
 */

import { useSyncExternalStore } from "react";
import { basename, sameDir } from "./lib";
import { chime } from "./sounds";
import type {
  AccountStatus,
  Approval,
  CatalogProvider,
  Chat,
  GlobalConfig,
  KumoEvent,
  Message,
  MessagePart,
  Prefs,
  Project,
  Quotas,
  SessionSnapshot,
  SettingsTab,
  SignInResult,
  Toast,
  ToolView,
  Turn,
  TurnOutcome,
} from "./types";

/** What a restored turn adds to the transcript besides its messages. */
export interface TurnMeta {
  /** The turn ran on another provider than the chat's earlier turns, with those replayed into its context. */
  replayed: boolean;
  /** The lead it ran on, when the record says. */
  provider: string | null;
  model: string | null;
}

export interface State {
  phase: "loading" | "onboarding" | "no-project" | "ready";
  /** Settings replaces the canvas below the title bar; the chat stays mounted behind it. */
  view: "chat" | "settings";
  settingsTab: SettingsTab;
  prefs: Prefs | null;
  session: SessionSnapshot | null;
  projects: Project[];
  chats: Chat[];
  messages: Message[];
  tools: Record<string, ToolView>;
  toolOrder: string[];
  /** Restored turns, by the turn id their messages carry. */
  turnMeta: Record<string, TurnMeta>;
  approvals: Approval[];
  toasts: Toast[];
  busy: boolean;
  quotas: Quotas;
  /** Scenes the scene frame reported: built-ins, then the user's own. */
  scenes: Array<{ id: string; name: string }>;
  /** Settings › Accounts; null until first loaded. */
  accounts: AccountStatus[] | null;
  /** Settings › Models; null until first loaded. */
  catalog: CatalogProvider[] | null;
  /** The saved defaults (config.json); null until first loaded. */
  globalConfig: GlobalConfig | null;
  /** A lead provider switch waiting for the user to confirm (ProviderSwitchModal). */
  providerSwitch: { provider: string; model: string } | null;
  /** The provider whose sign-in Kumo opened and is watching for; null when none. */
  signingIn: string | null;
  /** Why the last load of each Settings list failed; cleared when one succeeds. */
  loadErrors: Partial<Record<"accounts" | "catalog" | "globalConfig", string>>;
}

const MAX_TOOL_OUTPUT = 120_000;

let state: State = {
  phase: "loading",
  view: "chat",
  settingsTab: "accounts",
  prefs: null,
  session: null,
  projects: [],
  chats: [],
  messages: [],
  tools: {},
  toolOrder: [],
  turnMeta: {},
  approvals: [],
  toasts: [],
  busy: false,
  quotas: { orchestrator: null, antigravity: null, providers: {}, active: [] },
  scenes: [],
  accounts: null,
  catalog: null,
  globalConfig: null,
  providerSwitch: null,
  signingIn: null,
  loadErrors: {},
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

/**
 * The `name` a request's error takes when the engine restarted before it
 * answered; the restart notice covers those, so they never toast.
 */
export const ENGINE_RESTARTED = "EngineRestarted";

// Restarts seen so far: a request that sees this change was sent to an engine that is gone.
let engineRuns = 0;
window.kumo.onEngineRestart(() => engineRuns++);

export const invoke = <T,>(command: string, args?: unknown): Promise<T> => {
  const runs = engineRuns;
  return (window.kumo.invoke(command, args) as Promise<T>).catch((err: unknown) => {
    // contextBridge keeps only an error's message, so the mark is added here.
    if (engineRuns !== runs && err instanceof Error) err.name = ENGINE_RESTARTED;
    throw err;
  });
};

const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

let toastSeq = 1;
/**
 * A notification. General › error notifications off sends background errors
 * to the console instead; `always` is for the failure of something the user
 * just asked for, which they'd otherwise never hear about.
 */
export function toast(kind: Toast["kind"], text: string, options?: { always?: boolean }): void {
  if (kind === "error" && state.prefs?.errorToasts === false && !options?.always) {
    console.error(text);
    return;
  }
  const existing = state.toasts.find((t) => t.text === text && t.kind === kind);
  if (existing) {
    const prevTimer = toastTimers.get(existing.id);
    if (prevTimer) clearTimeout(prevTimer);
    if (kind !== "error") {
      toastTimers.set(
        existing.id,
        setTimeout(() => dismissToast(existing.id), 6000)
      );
    }
    return;
  }

  const id = toastSeq++;
  setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, text }] }));
  if (kind !== "error") {
    toastTimers.set(
      id,
      setTimeout(() => dismissToast(id), 6000)
    );
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The error toast for a request that failed. A request the engine never
 * answered because it restarted stays quiet: the restart notice covers it.
 */
export function toastFailure(err: unknown, text = errorText(err), options?: { always?: boolean }): void {
  if (err instanceof Error && err.name === ENGINE_RESTARTED) return;
  toast("error", text, options);
}

export function dismissToast(id: number): void {
  const timer = toastTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    toastTimers.delete(id);
  }
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

const message = (id: string, kind: Message["kind"], text: string, turnId: string | null = null): Message => ({
  id,
  kind,
  text,
  parts: text ? [{ kind: "text", text }] : [],
  turnId,
  streaming: false,
  thinking: false,
  failed: null,
});

type Restored = Pick<State, "messages" | "tools" | "toolOrder" | "turnMeta">;

/**
 * A saved chat back as the window draws it: each turn's prompt and answer,
 * its worker calls as tool cards (and Workers panel runs), and a note where a
 * turn continued on another provider. Older records have no tools.
 */
function restoreLog(log: Turn[]): Restored {
  const out: Restored = { messages: [], tools: {}, toolOrder: [], turnMeta: {} };
  log.forEach((turn, i) => {
    const turnId = `log-${i}`;
    const lead = message(`l${i}`, "lead", turn.responseSummary || "", turnId);
    const startedAt = (turn.timestamp || Date.now()) - (turn.elapsedMs ?? 0);
    // The log keeps only the final answer, so the worker calls come first.
    const toolParts: MessagePart[] = [];
    for (const [j, tool] of (Array.isArray(turn.tools) ? turn.tools : []).entries()) {
      const toolId = tool.toolId && !out.tools[tool.toolId] ? tool.toolId : `${turnId}-tool-${j}`;
      out.tools[toolId] = {
        toolId,
        turnId,
        name: tool.name,
        role: tool.role ?? null,
        task: tool.task ?? "",
        model: tool.model ?? null,
        effort: tool.effort ?? null,
        // A call that never reported (an interrupted turn) shows as done.
        status: tool.ok === false ? "failed" : "done",
        startedAt,
        // 0 when unknown: the cards leave the time out instead of counting from the turn.
        elapsedMs: tool.elapsedMs ?? 0,
        output: (tool.output ?? "").slice(-MAX_TOOL_OUTPUT),
      };
      out.toolOrder.push(toolId);
      toolParts.push({ kind: "tool", toolId });
    }
    out.messages.push(message(`u${i}`, "user", turn.prompt, turnId), { ...lead, parts: [...toolParts, ...lead.parts] });
    if (turn.replayed || turn.provider) {
      out.turnMeta[turnId] = { replayed: Boolean(turn.replayed), provider: turn.provider ?? null, model: turn.model ?? null };
    }
  });
  return out;
}

/** Text after a worker call starts a new paragraph, even if the model didn't end the last one. */
function appendText(parts: MessagePart[], text: string): MessagePart[] {
  const last = parts.at(-1);
  if (last?.kind === "text") return [...parts.slice(0, -1), { kind: "text", text: last.text + text }];
  return [...parts, { kind: "text", text: text.replace(/^\s+/, "") }];
}

/** Load the current chat's transcript and the chat list. */
export async function refreshChat(): Promise<void> {
  const session = state.session;
  if (!session) return;
  const [log, chats] = await Promise.all([
    invoke<Turn[]>("session.turnLog", { sessionId: session.id }),
    invoke<Chat[]>("session.listChats", { sessionId: session.id }),
  ]);
  setState({ ...restoreLog(log), chats, approvals: [] });
}

async function refreshProjects(): Promise<void> {
  setState({ projects: await invoke<Project[]>("projects.list") });
}

/** Open a workspace: a new session there, or move the current one. */
export async function openWorkspace(workspace: string, chatId?: string): Promise<void> {
  const current = state.session;
  const snapshot = current
    ? await invoke<SessionSnapshot>("session.setWorkspace", { sessionId: current.id, workspace, chatId })
    : await invoke<SessionSnapshot>("session.create", { workspace, chatId });
  setState({ session: snapshot, busy: snapshot.busy, quotas: snapshot.quotas, phase: "ready" });
  await savePrefs({ lastWorkspace: snapshot.workspace });
  void refreshQuotas();
  await Promise.all([refreshChat(), refreshProjects()]);
}

export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const prefs = await invoke<Prefs>("prefs.set", { patch });
  // A slider still settling keeps its value over what was saved before it.
  setState({ prefs: { ...prefs, ...unsavedPreview } });
}

let previewTimer: ReturnType<typeof setTimeout> | undefined;
let unsavedPreview: Partial<Prefs> = {};

/**
 * For sliders and other controls that change continuously: applies the patch
 * at once and saves ~300ms after the last change.
 */
export function previewPrefs(patch: Partial<Prefs>): void {
  setState((s) => (s.prefs ? { prefs: { ...s.prefs, ...patch } } : {}));
  unsavedPreview = { ...unsavedPreview, ...patch };
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const pending = unsavedPreview;
    unsavedPreview = {};
    // Saved without reading the result back: the control may have moved on.
    invoke("prefs.set", { patch: pending }).catch((err) => toastFailure(err));
  }, 300);
}

export async function boot(): Promise<void> {
  const [prefs, projects] = await Promise.all([invoke<Prefs>("prefs.get"), invoke<Project[]>("projects.list")]);
  setState({ prefs, projects });
  if (!prefs.onboarded) {
    // First run: the wizard. Someone with projects already used Kumo before
    // the wizard existed, so they skip it.
    if (projects.length === 0) {
      setState({ phase: "onboarding" });
      return;
    }
    savePrefs({ onboarded: true }).catch(() => {});
  }
  const known = new Set(projects.map((p) => p.path));
  const workspace = prefs.lastWorkspace && known.has(prefs.lastWorkspace) ? prefs.lastWorkspace : projects[0]?.path;
  if (!workspace) {
    setState({ phase: "no-project" });
    return;
  }
  try {
    await openWorkspace(workspace);
  } catch (err) {
    toastFailure(err, `Couldn't open ${workspace}: ${(err as Error).message}`);
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
    toastFailure(err);
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
  // If the current chat is already empty, stay on it.
  const currentChat = state.chats.find((c) => c.id === state.session?.chatId);
  const currentIsEmpty = state.messages.length === 0 && (currentChat ? (currentChat.turns ?? 0) === 0 : true);
  if (currentIsEmpty) return;

  // If another chat in this workspace is empty, navigate to it instead of making another.
  const emptyChat = state.chats.find((c) => (c.turns ?? 0) === 0);
  if (emptyChat) {
    await openChat(emptyChat.id);
    return;
  }

  const snapshot = await invoke<SessionSnapshot>("session.newChat", { sessionId: state.session.id });
  setState({ session: snapshot });
  await refreshChat();
}

/** A new chat in a project: here if it's the current one, else that project opens on an existing empty or fresh chat. */
export async function newChatIn(workspace: string): Promise<void> {
  if (state.busy) return;
  if (state.session && sameDir(state.session.workspace, workspace)) return newChat();
  const projectChats = await invoke<Chat[]>("projects.listChats", { workspace }).catch(() => []);
  const emptyChat = projectChats.find((c) => (c.turns ?? 0) === 0);
  if (emptyChat) {
    await openWorkspace(workspace, emptyChat.id);
  } else {
    await openWorkspace(workspace);
  }
}

/** Open an earlier chat. One that ran on another lead provider asks first: its turns get replayed. */
export async function openChat(chatId: string): Promise<void> {
  const session = state.session;
  if (!session || state.busy || chatId === session.chatId) return;
  const chat = state.chats.find((c) => c.id === chatId);
  const lead = session.settings.orchestratorProvider;
  if (chat?.provider && (chat.turns ?? 0) > 0 && !sameProvider(chat.provider, lead)) {
    if (!(await confirmProviderSwitch(lead, session.settings.orchestratorModel))) return;
    if (state.busy || state.session?.id !== session.id) return;
  }
  // The engine replays the earlier turns into the new provider and says so itself.
  await invoke<{ resumed: boolean; hadTurns?: boolean; replayed?: boolean }>("session.openChat", { sessionId: session.id, chatId });
}

export async function pickAndOpenFolder(): Promise<void> {
  const folder = await window.kumo.app.pickFolder();
  if (folder) await openWorkspace(folder);
}

export async function createProject(name: string, parentDir?: string): Promise<string | null> {
  try {
    const res = await invoke<{ project: Project; path: string; projects: Project[] }>("projects.create", {
      name,
      parentDir: parentDir || undefined,
    });
    setState({ projects: res.projects });
    await openWorkspace(res.path);
    toast("notice", `Created and opened project "${name}"`);
    return res.path;
  } catch (err) {
    toastFailure(err);
    return null;
  }
}

export async function addAccessibleFolder(workspace: string, folder: string): Promise<void> {
  try {
    const updated = await invoke<Project[]>("projects.addFolder", { workspace, folder });
    setState({ projects: updated });
    toast("notice", `Added accessible folder "${basename(folder)}"`);
  } catch (err) {
    toastFailure(err);
  }
}

export async function removeAccessibleFolder(workspace: string, folder: string): Promise<void> {
  try {
    const updated = await invoke<Project[]>("projects.removeFolder", { workspace, folder });
    setState({ projects: updated });
    toast("notice", `Removed accessible folder "${basename(folder)}"`);
  } catch (err) {
    toastFailure(err);
  }
}

export async function saveProjectSettings(
  workspace: string,
  patch: { name?: string; accessibleFolders?: string[] }
): Promise<void> {
  const cleanName = patch.name?.trim();
  let updatedProjects: Project[] | null = null;

  if (cleanName) {
    try {
      updatedProjects = await invoke<Project[]>("projects.rename", { workspace, name: cleanName });
    } catch {
      setState((prev) => ({
        projects: prev.projects.map((p) => (sameDir(p.path, workspace) ? { ...p, name: cleanName } : p)),
      }));
    }
  }

  if (patch.accessibleFolders) {
    try {
      updatedProjects = await invoke<Project[]>("projects.setAccessibleFolders", {
        workspace,
        folders: patch.accessibleFolders,
      });
    } catch {
      setState((prev) => ({
        projects: prev.projects.map((p) =>
          sameDir(p.path, workspace) ? { ...p, accessibleFolders: patch.accessibleFolders } : p
        ),
      }));
    }
  }

  if (updatedProjects) {
    setState({ projects: updatedProjects });
  }
  toast("notice", "Project settings saved");
}

export async function renameProject(workspace: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  try {
    const updated = await invoke<Project[]>("projects.rename", { workspace, name: clean });
    setState({ projects: updated });
    toast("notice", `Project renamed to "${clean}"`);
  } catch {
    setState((prev) => ({
      projects: prev.projects.map((p) => (sameDir(p.path, workspace) ? { ...p, name: clean } : p)),
    }));
    toast("notice", `Project renamed to "${clean}"`);
  }
}

export async function deleteProject(workspace: string): Promise<void> {
  try {
    const updated = await invoke<Project[]>("projects.delete", { workspace });
    setState({ projects: updated });
    toast("notice", "Project deleted");
    if (state.session && sameDir(state.session.workspace, workspace)) {
      if (updated.length > 0) {
        await openWorkspace(updated[0].path);
      } else {
        setState({ session: null, chats: [], phase: "no-project" });
      }
    }
  } catch {
    const remaining = state.projects.filter((p) => !sameDir(p.path, workspace));
    setState({ projects: remaining });
    toast("notice", "Project deleted");
    if (state.session && sameDir(state.session.workspace, workspace)) {
      if (remaining.length > 0) {
        void openWorkspace(remaining[0].path);
      } else {
        setState({ session: null, chats: [], phase: "no-project" });
      }
    }
  }
}

export async function reorderProjects(order: string[]): Promise<void> {
  const prevProjects = state.projects;
  const map = new Map(prevProjects.map((p) => [p.path, p]));
  const reordered: Project[] = [];
  for (const p of order) {
    const item = map.get(p);
    if (item) reordered.push(item);
  }
  for (const item of prevProjects) {
    if (!reordered.includes(item)) reordered.push(item);
  }
  setState({ projects: reordered });

  try {
    const updated = await invoke<Project[]>("projects.reorder", { order });
    setState({ projects: updated });
  } catch (err) {
    setState({ projects: prevProjects });
    toastFailure(err);
  }
}

export async function renameChat(workspace: string, chatId: string, title: string): Promise<void> {
  try {
    const updated = await invoke<Chat[]>("chat.rename", { workspace, chatId, title });
    if (state.session && sameDir(state.session.workspace, workspace)) {
      setState({ chats: updated });
    }
    toast("notice", `Chat renamed to "${title}"`);
  } catch (err) {
    toastFailure(err);
  }
}

export async function deleteChat(workspace: string, chatId: string): Promise<void> {
  try {
    const updated = await invoke<Chat[]>("chat.delete", { workspace, chatId });
    if (state.session && sameDir(state.session.workspace, workspace)) {
      setState({ chats: updated });
      if (state.session.chatId === chatId) {
        if (updated.length > 0) {
          await openChat(updated[0].id);
        } else {
          await newChat();
        }
      }
    }
    toast("notice", "Chat deleted");
  } catch {
    if (state.session && sameDir(state.session.workspace, workspace)) {
      const remaining = state.chats.filter((c) => c.id !== chatId);
      setState({ chats: remaining });
      if (state.session.chatId === chatId) {
        if (remaining.length > 0) {
          void openChat(remaining[0].id);
        } else {
          void newChat();
        }
      }
    }
    toast("notice", "Chat deleted");
  }
}

export async function moveChat(fromWorkspace: string, toWorkspace: string, chatId: string): Promise<void> {
  try {
    await invoke<{ ok: boolean }>("chat.move", { fromWorkspace, toWorkspace, chatId });
    if (state.session && sameDir(state.session.workspace, fromWorkspace)) {
      const remaining = await invoke<Chat[]>("projects.listChats", { workspace: fromWorkspace });
      setState({ chats: remaining });
      if (state.session.chatId === chatId) {
        await newChat();
      }
    }
    toast("notice", "Chat moved");
  } catch (err) {
    toastFailure(err);
  }
}

export async function reorderChats(workspace: string, order: string[]): Promise<void> {
  try {
    const updated = await invoke<Chat[]>("chat.reorder", { workspace, order });
    if (state.session && sameDir(state.session.workspace, workspace)) {
      setState({ chats: updated });
    }
  } catch (err) {
    toastFailure(err);
  }
}

/** A view that opens often (Accounts, the window coming back) reads usage again at most this often... */
const QUOTA_VIEW_MS = 15_000;
/** ...and the window regaining focus at most this often. */
const QUOTA_FOCUS_MS = 60_000;

let quotaRead: Promise<void> | null = null;
let quotaReadAt = 0;

/**
 * Read every account's usage again, with or without a session, and keep the
 * snapshot (its `active` names the providers in use). It runs in the
 * background, so a failure leaves the figures as they were and toasts nothing.
 * Callers share a read in flight. `throttle` is for views that open often: it
 * skips the read when one finished in the last 15 seconds. The Refresh button
 * and a session opening read regardless.
 */
export function refreshQuotas({ throttle = false }: { throttle?: boolean } = {}): Promise<void> {
  if (quotaRead) return quotaRead;
  if (throttle && Date.now() - quotaReadAt < QUOTA_VIEW_MS) return Promise.resolve();
  const read: Promise<void> = invoke<Quotas>("quotas.refresh", {})
    .then((quotas) => {
      quotaReadAt = Date.now();
      setState({ quotas });
    })
    .catch((err: unknown) => {
      // The restart notice covers a read the engine never answered.
      if (!(err instanceof Error && err.name === ENGINE_RESTARTED)) console.warn(`Couldn't read usage: ${errorText(err)}`);
    })
    .finally(() => {
      if (quotaRead === read) quotaRead = null;
    });
  quotaRead = read;
  return read;
}

// The window coming back into focus reads usage again, at most once a minute.
let windowFocused = true;
let focusReadAt = 0;
window.kumo.app.onWindowState(({ focused }) => {
  const regained = focused && !windowFocused;
  windowFocused = focused;
  if (!regained || state.phase !== "ready" || Date.now() - focusReadAt < QUOTA_FOCUS_MS) return;
  focusReadAt = Date.now();
  void refreshQuotas({ throttle: true });
});

let finishing = false;

/**
 * First run done (or skipped): open the project the wizard picked, if any.
 * False when that project couldn't be opened: the wizard stays, so the user
 * can pick another, and isn't marked done. One at a time: a second click
 * would start a second engine session.
 */
export async function finishOnboarding(workspace: string | null): Promise<boolean> {
  if (finishing) return false;
  finishing = true;
  try {
    if (workspace) {
      try {
        await openWorkspace(workspace);
      } catch (err) {
        toastFailure(err, `Couldn't open ${workspace}: ${errorText(err)}`, { always: true });
        return false;
      }
    }
    await savePrefs({ onboarded: true }).catch((err) => toastFailure(err, undefined, { always: true }));
    if (!workspace) setState({ phase: "no-project" });
    return true;
  } finally {
    finishing = false;
  }
}

// ── settings ──

/** The element that had focus when Settings opened, focused again when it closes. */
let settingsOpener: HTMLElement | null = null;

export function openSettings(tab?: SettingsTab): void {
  if (state.view !== "settings") {
    const active = document.activeElement;
    settingsOpener = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  setState((s) => ({ view: "settings", settingsTab: tab ?? s.settingsTab }));
}

export function closeSettings(): void {
  if (state.view !== "settings") return;
  stopSignInPoll();
  setState({ view: "chat" });
  const opener = settingsOpener;
  settingsOpener = null;
  // After React has drawn the chat back (no longer inert), so the opener can take focus.
  if (opener) {
    setTimeout(() => {
      if (opener.isConnected && !opener.closest("[inert]")) opener.focus({ preventScroll: true });
    }, 0);
  }
}

export function setSettingsTab(tab: SettingsTab): void {
  setState({ settingsTab: tab });
}

/** Every Settings load reports its own failure, keeps what was shown, and leaves the reason in loadErrors. */
async function load<K extends "accounts" | "catalog" | "globalConfig">(key: K, command: string, args?: unknown): Promise<void> {
  try {
    const value = await invoke<State[K]>(command, args);
    setState((s) => {
      const { [key]: _gone, ...loadErrors } = s.loadErrors;
      return { [key]: value, loadErrors } as Pick<State, K | "loadErrors">;
    });
  } catch (err) {
    const message = errorText(err);
    setState((s) => ({ loadErrors: { ...s.loadErrors, [key]: message } }));
    toastFailure(err, message, { always: true });
  }
}

/** Settings › Accounts. `refresh` asks each CLI again instead of using the engine's cache. */
export const loadAccounts = (refresh = false): Promise<void> => load("accounts", "accounts.list", { refresh });

/** Settings › Models. `refresh` lists live models again where the provider can. */
export const loadCatalog = (refresh = false): Promise<void> => load("catalog", "models.catalog", { refresh });

export const loadGlobalConfig = (): Promise<void> => load("globalConfig", "config.get");

const SIGN_IN_POLL_MS = 3000;
const SIGN_IN_POLL_LIMIT_MS = 120_000;
let signInPoll: { provider: string; timer: ReturnType<typeof setTimeout> | undefined } | null = null;

function stopSignInPoll(): void {
  if (signInPoll) clearTimeout(signInPoll.timer);
  signInPoll = null;
  if (state.signingIn !== null) setState({ signingIn: null });
}

/**
 * Watches Accounts until the provider reports signed in (a new account counts
 * when it already was), two minutes pass, or Settings closes.
 */
function startSignInPoll(provider: string): void {
  stopSignInPoll();
  const before = state.accounts?.find((a) => a.provider === provider);
  const startedAt = Date.now();
  const poll: NonNullable<typeof signInPoll> = { provider, timer: undefined };
  signInPoll = poll;
  setState({ signingIn: provider });
  // closeSettings stops it too; the onboarding wizard can use it outside Settings.
  const next = () => {
    if (signInPoll !== poll) return;
    if (Date.now() - startedAt >= SIGN_IN_POLL_LIMIT_MS) {
      stopSignInPoll();
      toast("notice", `Stopped waiting for ${before?.name ?? provider}. Refresh Accounts once you've finished signing in.`);
      return;
    }
    poll.timer = setTimeout(() => void tick(), SIGN_IN_POLL_MS);
  };
  const tick = async () => {
    let accounts: AccountStatus[];
    try {
      accounts = await invoke<AccountStatus[]>("accounts.list", { refresh: true });
    } catch {
      return next();
    }
    if (signInPoll !== poll) return;
    setState({ accounts });
    const now = accounts.find((a) => a.provider === provider);
    const done = now?.signedIn === true && (before?.signedIn !== true || now.account !== before.account);
    if (done) {
      stopSignInPoll();
      toast("notice", `Signed in to ${now.name}.`);
      return;
    }
    next();
  };
  next();
}

/**
 * Opens the provider's own sign-in in a terminal, then watches for it to
 * finish (`signingIn` names it meanwhile). False when no terminal opened.
 */
export async function signIn(provider: string): Promise<boolean> {
  if (state.signingIn === provider) return true;
  stopSignInPoll();
  setState({ signingIn: provider });
  let result: SignInResult;
  try {
    result = await invoke<SignInResult>("accounts.signIn", { provider });
  } catch (err) {
    if (state.signingIn === provider) setState({ signingIn: null });
    toastFailure(err, undefined, { always: true });
    return false;
  }
  if (!result.launched) {
    if (state.signingIn === provider) setState({ signingIn: null });
    toast("error", `Couldn't open a terminal to sign in. Run ${result.command} in one, then refresh.`, { always: true });
    return false;
  }
  toast("notice", `Finish signing in in the terminal window (${result.command}).`);
  startSignInPoll(provider);
  return true;
}

export async function signOut(provider: string): Promise<void> {
  try {
    const fresh = await invoke<AccountStatus>("accounts.signOut", { provider });
    if (signInPoll?.provider === provider || state.signingIn === provider) stopSignInPoll();
    setState((s) => {
      const list = s.accounts ?? [];
      const known = list.some((a) => a.provider === fresh.provider);
      return { accounts: known ? list.map((a) => (a.provider === fresh.provider ? fresh : a)) : [...list, fresh] };
    });
  } catch (err) {
    toastFailure(err, undefined, { always: true });
  }
}

/** "agy" and "antigravity" are one provider. */
const canonicalProvider = (p: string | null | undefined): string => {
  const v = (p ?? "").trim().toLowerCase();
  return v === "agy" ? "antigravity" : v;
};
const sameProvider = (a: string | null | undefined, b: string | null | undefined): boolean =>
  canonicalProvider(a) === canonicalProvider(b);

/** The open chat has turns a new lead provider would have replayed into its context. */
function chatHasTurns(): boolean {
  const session = state.session;
  if (!session) return false;
  const chat = state.chats.find((c) => c.id === session.chatId);
  return (chat?.turns ?? 0) > 0 || state.messages.length > 0;
}

let answerSwitch: ((ok: boolean) => void) | null = null;

/** Asks (ProviderSwitchModal) before a chat continues on another lead provider; true to go ahead. */
function confirmProviderSwitch(provider: string, model: string): Promise<boolean> {
  if (state.prefs?.skipProviderSwitchWarning) return Promise.resolve(true);
  // A newer question replaces one still open.
  answerSwitch?.(false);
  return new Promise<boolean>((resolve) => {
    answerSwitch = resolve;
    setState({ providerSwitch: { provider, model } });
  });
}

export function answerProviderSwitch(ok: boolean, dontAskAgain: boolean): void {
  const resolve = answerSwitch;
  answerSwitch = null;
  setState({ providerSwitch: null });
  if (ok && dontAskAgain) savePrefs({ skipProviderSwitchWarning: true }).catch((err) => toastFailure(err));
  resolve?.(ok);
}

/** Settings that decide which providers are in use. */
const CREW_KEYS = ["orchestratorProvider", "orchestratorModel", "workerProvider", "workerModel", "roles"];

/**
 * Change engine settings. With a session they apply now and are saved as the
 * defaults; without one only the defaults change. A lead provider switch on a
 * chat with turns asks first. Resolves false when cancelled or failed.
 */
export async function updateSettings(patch: Record<string, unknown>): Promise<boolean> {
  const session = state.session;
  const provider = typeof patch.orchestratorProvider === "string" ? patch.orchestratorProvider : null;
  if (session && provider && !sameProvider(provider, session.settings.orchestratorProvider) && chatHasTurns()) {
    const model = typeof patch.orchestratorModel === "string" ? patch.orchestratorModel : "";
    if (!(await confirmProviderSwitch(provider, model))) return false;
  }
  try {
    const current = state.session;
    if (current) {
      await invoke("session.updateSettings", { sessionId: current.id, patch, persist: true });
      if (state.globalConfig) void loadGlobalConfig();
    } else {
      await invoke("config.update", { patch });
      await loadGlobalConfig();
      // With a session, the engine reports the providers now in use itself; without one, ask.
      if (CREW_KEYS.some((key) => key in patch)) void refreshQuotas();
    }
    return true;
  } catch (err) {
    toastFailure(err, undefined, { always: true });
    return false;
  }
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
          message(`${event.turnId}-u`, "user", event.prompt, event.turnId),
          { ...message(`${event.turnId}-l`, "lead", "", event.turnId), streaming: true, thinking: true },
        ],
      }));
      break;
    case "turn.delta":
      updateLead(event.turnId, (m) => ({ ...m, text: m.text + event.text, parts: appendText(m.parts, event.text), thinking: false }));
      break;
    case "turn.reasoning":
      updateLead(event.turnId, (m) => ({ ...m, thinking: m.text === "" }));
      break;
    case "turn.completed":
      updateLead(event.turnId, (m) => ({ ...m, streaming: false, thinking: false }));
      setState({ busy: false });
      if (state.prefs?.sounds) chime("done", state.prefs.soundVolume);
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
            role: event.role ?? null,
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
          ? s.messages.map((m) =>
              m.kind === "lead" && m.turnId === event.turnId
                ? { ...m, parts: [...m.parts, { kind: "tool", toolId: event.toolId }] }
                : m
            )
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
      if (state.prefs?.sounds) chime("approval", state.prefs.soundVolume);
      break;
    case "approval.resolved":
      setState((s) => ({ approvals: s.approvals.filter((a) => a.approvalId !== event.approvalId) }));
      break;
    case "quota.updated":
      setState({
        quotas: { orchestrator: event.orchestrator, antigravity: event.antigravity, providers: event.providers ?? {}, active: event.active },
      });
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
