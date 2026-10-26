import { Fragment, useEffect, useRef, useState } from "react";
import { basename, dirname, providerLabel, sameDir } from "../lib";
import {
  addAccessibleFolder,
  createProject,
  deleteChat,
  deleteProject,
  moveChat,
  newChatIn,
  openChat,
  openWorkspace,
  pickAndOpenFolder,
  removeAccessibleFolder,
  renameChat,
  renameProject,
  reorderChats,
  reorderProjects,
  saveProjectSettings,
  toast,
  toastFailure,
  useStore,
} from "../store";
import type { Chat, Project, Quotas, SessionSettings } from "../types";
import {
  IconChevronRight,
  IconClose,
  IconCollapseAll,
  IconCopy,
  IconFolder,
  IconGear,
  IconMore,
  IconPencil,
  IconPlus,
  IconTrash,
} from "./icons";
import { Modal } from "./settings/controls";

/** One usage window: the share left (0-100) and when it resets. */
export type MeterWindow = { left: number; reset: string | null };
/** One bar per provider or Antigravity pool, with its 5-hour, weekly and monthly windows layered on the same track. */
export type Meter = { label: string; fiveHour: MeterWindow | null; weekly: MeterWindow | null; monthly: MeterWindow | null };
type WindowKey = "fiveHour" | "weekly" | "monthly";

const WINDOW_KEYS: WindowKey[] = ["fiveHour", "weekly", "monthly"];
const WINDOW_NAME: Record<WindowKey, string> = { fiveHour: "5-hour", weekly: "Weekly", monthly: "Monthly" };
const WINDOW_SHORT: Record<WindowKey, string> = { fiveHour: "5h", weekly: "weekly", monthly: "monthly" };

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

/** Windows up to 6 hours are the 5-hour limit; up to 8 days are weekly; longer is monthly. */
function windowKey(windowMinutes: unknown, fallback: WindowKey): WindowKey {
  const mins = num(windowMinutes);
  if (!mins) return fallback;
  if (mins <= 360) return "fiveHour";
  if (mins <= 11520) return "weekly";
  return "monthly";
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
export function meters(quotas: Quotas, settings: SessionSettings | undefined, allProviders = false): Meter[] {
  const out: Meter[] = [];
  const targets = activeTargets(settings);
  const leadProvider = normProvider(settings?.orchestratorProvider);

  const directProviders: string[] = [];
  const addProvider = (p: string) => {
    if (p && p !== "antigravity" && !directProviders.includes(p)) directProviders.push(p);
  };
  if (leadProvider) addProvider(leadProvider);
  for (const t of targets) addProvider(t.provider);
  if (allProviders) {
    for (const p of Object.keys(quotas.providers || {})) {
      addProvider(p);
    }
  }
  if (directProviders.length === 0 && quotas.orchestrator) directProviders.push("lead");

  for (const p of directProviders) {
    const limits =
      quotas.providers?.[p] ??
      (p === leadProvider || p === "lead" ? quotas.orchestrator : null);
    const used = num(limits?.usedPercent);
    if (!limits || used === null) continue;
    const meter: Meter = { label: (p === "lead" ? "" : providerLabel(p)) || "Lead", fiveHour: null, weekly: null, monthly: null };
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
  const usesAgy = allProviders ? Boolean(a) : (agyTargets.length > 0 || (!settings && Boolean(a)));
  if (a && usesAgy) {
    const pool = (label: string, fiveHour: MeterWindow | null, weekly: MeterWindow | null, monthly: MeterWindow | null = null) => {
      if (fiveHour || weekly || monthly) out.push({ label, fiveHour, weekly, monthly });
    };
    const usesGeminiFamily = allProviders || agyTargets.length === 0 || agyTargets.some((t) => !isClaudeOrGpt(t.model));
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
    if (allProviders || agyTargets.some((t) => isClaudeOrGpt(t.model))) {
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

/** The shortest fill draws on top so all stay visible. */
function topWindow(row: Meter): WindowKey | null {
  const wins = windowsOf(row);
  if (wins.length <= 1) return null;
  wins.sort((a, b) => a[1].left - b[1].left);
  return wins[0][0];
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

export function MeterRow({ row }: { row: Meter }) {
  const windows = windowsOf(row);
  const top = topWindow(row);
  const resets = windows.filter((entry): entry is [WindowKey, MeterWindow & { reset: string }] => Boolean(entry[1].reset));
  return (
    <div className="meter" data-part="meter" aria-label={describe(row)}>
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [projectChats, setProjectChats] = useState<Record<string, Chat[]>>({});
  const [optimisticWorkspace, setOptimisticWorkspace] = useState<string | null>(null);

  // Inline rename state
  const [editingProject, setEditingProject] = useState<{ path: string; name: string } | null>(null);
  const [editingChat, setEditingChat] = useState<{ workspace: string; chatId: string; title: string } | null>(null);

  // Context / action menu state
  const [activeMenu, setActiveMenu] = useState<
    | { type: "project"; path: string; x: number; y: number }
    | { type: "chat"; workspace: string; chatId: string; x: number; y: number }
    | { type: "canvas"; x: number; y: number }
    | null
  >(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Drag & drop state
  const [draggingProject, setDraggingProject] = useState<string | null>(null);
  const [dragOverProject, setDragOverProject] = useState<{ path: string; pos: "before" | "after" | "inside" } | null>(null);
  const [draggingChat, setDraggingChat] = useState<{ workspace: string; chatId: string } | null>(null);
  const [dragOverChat, setDragOverChat] = useState<{ chatId: string; pos: "before" | "after" } | null>(null);
  const [isDragOverExternal, setIsDragOverExternal] = useState(false);
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<Project | null>(null);

  const handleAddAccessibleFolder = async (projectPath: string) => {
    setActiveMenu(null);
    try {
      const picked = await window.kumo.app.pickFolder();
      if (picked) {
        if (sameDir(picked, projectPath)) {
          toast("warning", "Folder is already the project workspace root");
          return;
        }
        await addAccessibleFolder(projectPath, picked);
      }
    } catch (err) {
      toast("error", (err as Error).message);
    }
  };

  const activeWorkspace = optimisticWorkspace || session?.workspace;

  const isProjectExpanded = (path: string, isCurrent: boolean) => {
    if (path in collapsed) {
      return !collapsed[path];
    }
    return isCurrent;
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const p of list) next[p.path] = true;
    setCollapsed(next);
  };

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    for (const p of list) next[p.path] = false;
    setCollapsed(next);
  };

  // External folder drag and drop (from Windows File Explorer)
  const handleExternalDragOver = (e: React.DragEvent) => {
    if (draggingProject || draggingChat) return;
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setIsDragOverExternal(true);
    }
  };

  const handleExternalDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOverExternal(false);
  };

  const handleExternalDrop = (e: React.DragEvent) => {
    if (draggingProject || draggingChat) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOverExternal(false);
      const file = e.dataTransfer.files[0];
      const filePath = (file as unknown as { path?: string }).path;
      if (filePath) {
        void openWorkspace(filePath).catch((err) => toastFailure(err));
      }
    }
  };

  const list =
    session && !projects.some((p) => sameDir(p.path, session.workspace))
      ? [{ path: session.workspace, name: basename(session.workspace) }, ...projects]
      : projects;

  const refreshProjectChats = async (workspacePath: string) => {
    try {
      const loaded = (await window.kumo.invoke("projects.listChats", { workspace: workspacePath })) as Chat[];
      if (Array.isArray(loaded)) {
        setProjectChats((prev) => ({ ...prev, [workspacePath]: loaded }));
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    let unmounted = false;
    for (const p of list) {
      if (!sameDir(p.path, session?.workspace) && !projectChats[p.path]) {
        (window.kumo.invoke("projects.listChats", { workspace: p.path }) as Promise<Chat[]>)
          .then((loaded) => {
            if (!unmounted && Array.isArray(loaded)) {
              setProjectChats((prev) => ({ ...prev, [p.path]: loaded }));
            }
          })
          .catch(() => {});
      }
    }
    return () => {
      unmounted = true;
    };
  }, [list, session?.workspace]);

  useEffect(() => {
    if (session?.workspace) {
      setProjectChats((prev) => ({ ...prev, [session.workspace]: chats }));
    }
  }, [session?.workspace, chats]);

  // Click outside / Escape dismisses active action menu
  useEffect(() => {
    if (!activeMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveMenu(null);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [activeMenu]);

  const open = (path: string) => {
    setOptimisticWorkspace(path);
    return openWorkspace(path)
      .catch((err) => toastFailure(err))
      .finally(() => setOptimisticWorkspace(null));
  };

  const toggleProject = (path: string, isCurrent: boolean) => {
    if (editingProject) return;
    const currentlyExpanded = isProjectExpanded(path, isCurrent);
    if (isCurrent) {
      setCollapsed((prev) => ({ ...prev, [path]: currentlyExpanded }));
    } else {
      setCollapsed((prev) => ({ ...prev, [path]: false }));
      void open(path);
    }
  };

  /** The row's +: a fresh chat in that project, which opens expanded. */
  const newChatHere = (path: string, isCurrent: boolean) => {
    setCollapsed((prev) => ({ ...prev, [path]: false }));
    if (!isCurrent) setOptimisticWorkspace(path);
    void newChatIn(path)
      .catch((err) => toastFailure(err))
      .finally(() => setOptimisticWorkspace(null));
  };

  // Rename handlers
  const startRenameProject = (project: { path: string; name: string }) => {
    setActiveMenu(null);
    setEditingProject({ path: project.path, name: project.name });
  };

  const commitProjectRename = async () => {
    if (!editingProject) return;
    const { path, name } = editingProject;
    setEditingProject(null);
    const trimmed = name.trim();
    if (trimmed) {
      await renameProject(path, trimmed);
    }
  };

  const startRenameChat = (workspace: string, chat: { id: string; title: string }) => {
    setActiveMenu(null);
    setEditingChat({ workspace, chatId: chat.id, title: chat.title || "Untitled chat" });
  };

  const commitChatRename = async () => {
    if (!editingChat) return;
    const { workspace, chatId, title } = editingChat;
    setEditingChat(null);
    const trimmed = title.trim();
    if (trimmed) {
      await renameChat(workspace, chatId, trimmed);
      await refreshProjectChats(workspace);
    }
  };

  // Delete handlers
  const handleDeleteProject = async (path: string) => {
    setActiveMenu(null);
    setProjectChats((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
    await deleteProject(path);
  };

  const handleDeleteChat = async (workspace: string, chatId: string) => {
    setActiveMenu(null);
    setProjectChats((prev) => ({
      ...prev,
      [workspace]: (prev[workspace] || []).filter((c) => c.id !== chatId),
    }));
    await deleteChat(workspace, chatId);
    await refreshProjectChats(workspace);
  };

  // Drag & drop handlers for projects
  const handleProjectDragStart = (e: React.DragEvent, projectPath: string) => {
    e.dataTransfer.setData("application/kumo-project", projectPath);
    e.dataTransfer.effectAllowed = "move";
    setDraggingProject(projectPath);
  };

  const handleProjectDragOver = (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggingProject && draggingProject !== targetPath) {
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
      setDragOverProject({ path: targetPath, pos });
    } else if (draggingChat && !sameDir(draggingChat.workspace, targetPath)) {
      setDragOverProject({ path: targetPath, pos: "inside" });
    }
  };

  const handleProjectDrop = async (e: React.DragEvent, targetPath: string) => {
    e.preventDefault();
    e.stopPropagation();
    const projectData = e.dataTransfer.getData("application/kumo-project") || draggingProject;
    const chatDataStr = e.dataTransfer.getData("application/kumo-chat");

    if (projectData && projectData !== targetPath && dragOverProject && dragOverProject.pos !== "inside") {
      const currentIndex = list.findIndex((p) => p.path === projectData);
      const targetIndex = list.findIndex((p) => p.path === targetPath);
      if (currentIndex !== -1 && targetIndex !== -1) {
        const newList = [...list];
        const [moved] = newList.splice(currentIndex, 1);
        const insertAt = dragOverProject.pos === "before" ? targetIndex : targetIndex + 1;
        newList.splice(insertAt > currentIndex ? insertAt - 1 : insertAt, 0, moved);
        void reorderProjects(newList.map((p) => p.path));
      }
    } else if (chatDataStr || draggingChat) {
      const chatData = chatDataStr ? (JSON.parse(chatDataStr) as { workspace: string; chatId: string }) : draggingChat;
      if (chatData && !sameDir(chatData.workspace, targetPath)) {
        await moveChat(chatData.workspace, targetPath, chatData.chatId);
        await refreshProjectChats(chatData.workspace);
        await refreshProjectChats(targetPath);
        setCollapsed((prev) => ({ ...prev, [targetPath]: false }));
      }
    }

    setDraggingProject(null);
    setDragOverProject(null);
    setDraggingChat(null);
    setDragOverChat(null);
  };

  // Drag & drop handlers for chats
  const handleChatDragStart = (e: React.DragEvent, workspace: string, chatId: string) => {
    const payload = JSON.stringify({ workspace, chatId });
    e.dataTransfer.setData("application/kumo-chat", payload);
    e.dataTransfer.effectAllowed = "move";
    setDraggingChat({ workspace, chatId });
  };

  const handleChatDragOver = (e: React.DragEvent, targetChatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (draggingChat && draggingChat.chatId !== targetChatId) {
      const rect = e.currentTarget.getBoundingClientRect();
      const pos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
      setDragOverChat({ chatId: targetChatId, pos });
    }
  };

  const handleChatDrop = async (e: React.DragEvent, workspace: string, targetChatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const chatDataStr = e.dataTransfer.getData("application/kumo-chat");
    const chatData = chatDataStr ? (JSON.parse(chatDataStr) as { workspace: string; chatId: string }) : draggingChat;

    if (chatData && sameDir(chatData.workspace, workspace) && chatData.chatId !== targetChatId && dragOverChat) {
      const currentChats = sameDir(workspace, session?.workspace) ? chats : projectChats[workspace] || [];
      const currentIndex = currentChats.findIndex((c) => c.id === chatData.chatId);
      const targetIndex = currentChats.findIndex((c) => c.id === targetChatId);
      if (currentIndex !== -1 && targetIndex !== -1) {
        const newChats = [...currentChats];
        const [moved] = newChats.splice(currentIndex, 1);
        const insertAt = dragOverChat.pos === "before" ? targetIndex : targetIndex + 1;
        newChats.splice(insertAt > currentIndex ? insertAt - 1 : insertAt, 0, moved);
        await reorderChats(workspace, newChats.map((c) => c.id));
        await refreshProjectChats(workspace);
      }
    }

    setDraggingChat(null);
    setDragOverChat(null);
  };

  return (
    <nav
      className={`sidebar glass ${isDragOverExternal ? "drag-over-external" : ""}`}
      data-part="sidebar"
      aria-label="Projects and chats"
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
    >
      <div
        className="side-scroll"
        onContextMenu={(e) => {
          e.preventDefault();
          setActiveMenu({ type: "canvas", x: e.clientX, y: e.clientY });
        }}
      >
        <div className="sidebar-section">Projects</div>
        {list.map((project) => {
          const isCurrent = sameDir(project.path, activeWorkspace);
          const isExpanded = isProjectExpanded(project.path, isCurrent);
          const pChats = sameDir(project.path, session?.workspace) ? chats : projectChats[project.path] || [];
          const chatListed = isCurrent && pChats.some((c) => c.id === session?.chatId);
          const isEditingThisProject = editingProject?.path === project.path;
          const isProjectMenuOpen = activeMenu?.type === "project" && activeMenu.path === project.path;

          const dropPos = dragOverProject?.path === project.path ? dragOverProject.pos : null;
          const dropClass = dropPos === "before" ? "drop-before" : dropPos === "after" ? "drop-after" : dropPos === "inside" ? "drop-inside" : "";

          return (
            <div key={project.path} className="project-group">
              <div
                className={`project-row ${dropClass}`}
                data-part="project-row"
                data-current={isCurrent}
                data-disabled={busy && !isCurrent}
                draggable={!isEditingThisProject}
                onDragStart={(e) => handleProjectDragStart(e, project.path)}
                onDragOver={(e) => handleProjectDragOver(e, project.path)}
                onDragLeave={() => {
                  if (dragOverProject?.path === project.path) setDragOverProject(null);
                }}
                onDrop={(e) => void handleProjectDrop(e, project.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setActiveMenu({ type: "project", path: project.path, x: e.clientX, y: e.clientY });
                }}
              >
                {isEditingThisProject ? (
                  <input
                    autoFocus
                    className="side-inline-input"
                    value={editingProject.name}
                    aria-label="Edit project name"
                    onChange={(e) => setEditingProject({ ...editingProject, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitProjectRename();
                      else if (e.key === "Escape") setEditingProject(null);
                    }}
                    onBlur={() => void commitProjectRename()}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <button
                    className="side-item project"
                    aria-current={isCurrent}
                    aria-expanded={isExpanded}
                    disabled={busy && !isCurrent}
                    onClick={() => toggleProject(project.path, isCurrent)}
                  >
                    <span className="project-name">{project.name}</span>
                  </button>
                )}

                <button
                  type="button"
                  className="project-add"
                  data-part="project-new-chat"
                  aria-label={`New session in ${project.name}`}
                  data-tooltip="New chat"
                  data-tooltip-pos="bottom"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    newChatHere(project.path, isCurrent);
                  }}
                >
                  <IconPlus />
                </button>

                <button
                  type="button"
                  className="side-item-more"
                  aria-label={`Options for ${project.name}`}
                  aria-expanded={isProjectMenuOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isProjectMenuOpen) {
                      setActiveMenu(null);
                    } else {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setActiveMenu({
                        type: "project",
                        path: project.path,
                        x: rect.right - 170,
                        y: rect.bottom + 4,
                      });
                    }
                  }}
                >
                  <IconMore />
                </button>

                <span
                  className={`project-chevron ${isExpanded ? "open" : ""}`}
                  role="button"
                  aria-label={isExpanded ? "Collapse project" : "Expand project"}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    const currentlyExpanded = isProjectExpanded(project.path, isCurrent);
                    setCollapsed((prev) => ({ ...prev, [project.path]: currentlyExpanded }));
                  }}
                >
                  <IconChevronRight />
                </span>
              </div>

              <div
                className="project-accordion"
                data-expanded={isExpanded}
                aria-hidden={!isExpanded}
              >
                <div className="project-accordion-inner">
                  {isCurrent && !chatListed && (
                    <div
                      className="chat-row"
                      data-current="true"
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (session?.chatId) {
                          setActiveMenu({
                            type: "chat",
                            workspace: project.path,
                            chatId: session.chatId,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }
                      }}
                    >
                      <button className="side-item chat" aria-current="true">
                        New chat
                      </button>
                    </div>
                  )}
                  {pChats.map((chat) => {
                    const isChatCurrent = isCurrent && chat.id === session?.chatId;
                    const isEditingThisChat = editingChat?.chatId === chat.id;
                    const isChatMenuOpen = activeMenu?.type === "chat" && activeMenu.chatId === chat.id;
                    const chatDropPos = dragOverChat?.chatId === chat.id ? dragOverChat.pos : null;
                    const chatDropClass = chatDropPos === "before" ? "drop-before" : chatDropPos === "after" ? "drop-after" : "";

                    return (
                      <div
                        key={chat.id}
                        className={`chat-row ${chatDropClass}`}
                        data-current={isChatCurrent}
                        draggable={!isEditingThisChat}
                        onDragStart={(e) => handleChatDragStart(e, project.path, chat.id)}
                        onDragOver={(e) => handleChatDragOver(e, chat.id)}
                        onDragLeave={() => {
                          if (dragOverChat?.chatId === chat.id) setDragOverChat(null);
                        }}
                        onDrop={(e) => void handleChatDrop(e, project.path, chat.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setActiveMenu({
                            type: "chat",
                            workspace: project.path,
                            chatId: chat.id,
                            x: e.clientX,
                            y: e.clientY,
                          });
                        }}
                      >
                        {isEditingThisChat ? (
                          <input
                            autoFocus
                            className="side-inline-input"
                            value={editingChat.title}
                            aria-label="Edit chat title"
                            onChange={(e) => setEditingChat({ ...editingChat, title: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitChatRename();
                              else if (e.key === "Escape") setEditingChat(null);
                            }}
                            onBlur={() => void commitChatRename()}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <button
                            className="side-item chat"
                            aria-current={isChatCurrent}
                            disabled={busy}
                            onClick={() => {
                              if (isChatCurrent) return;
                              if (!isCurrent) {
                                void openWorkspace(project.path, chat.id).catch((err) => toastFailure(err));
                              } else {
                                void openChat(chat.id).catch((err) => toastFailure(err));
                              }
                            }}
                          >
                            {chat.title || "Untitled chat"}
                          </button>
                        )}

                        <button
                          type="button"
                          className="side-item-more"
                          aria-label={`Options for ${chat.title || "chat"}`}
                          aria-expanded={isChatMenuOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isChatMenuOpen) {
                              setActiveMenu(null);
                            } else {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setActiveMenu({
                                type: "chat",
                                workspace: project.path,
                                chatId: chat.id,
                                x: rect.right - 170,
                                y: rect.bottom + 4,
                              });
                            }
                          }}
                        >
                          <IconMore />
                        </button>
                      </div>
                    );
                  })}
                  {project.accessibleFolders && project.accessibleFolders.length > 0 && (
                    <div className="accessible-folders-block">
                      <div className="accessible-folders-head">
                        <span>Accessible Folders ({project.accessibleFolders.length})</span>
                        <button
                          type="button"
                          className="sidebar-icon-btn"
                          aria-label="Add accessible folder"
                          data-tooltip="Add folder"
                          data-tooltip-pos="left"
                          onClick={() => void handleAddAccessibleFolder(project.path)}
                        >
                          <IconPlus />
                        </button>
                      </div>
                      {project.accessibleFolders.map((folder) => (
                        <div key={folder} className="accessible-folder-row">
                          <span className="accessible-folder-icon" aria-hidden="true">
                            <IconFolder />
                          </span>
                          <span className="accessible-folder-name" data-tooltip={folder} data-tooltip-pos="left">
                            {basename(folder)}
                          </span>
                          <button
                            type="button"
                            className="accessible-folder-remove"
                            aria-label={`Remove access to ${basename(folder)}`}
                            data-tooltip="Remove"
                            data-tooltip-pos="left"
                            onClick={() => void removeAccessibleFolder(project.path, folder)}
                          >
                            <IconClose />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {activeMenu && (
          <div
            className="side-menu"
            ref={menuRef}
            style={{
              position: "fixed",
              left: Math.max(8, Math.min(activeMenu.x, window.innerWidth - 190)),
              top: Math.max(
                8,
                Math.min(
                  activeMenu.y,
                  window.innerHeight - (activeMenu.type === "project" ? 180 : activeMenu.type === "chat" ? 170 : 140)
                )
              ),
              zIndex: 100,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {activeMenu.type === "project" && (() => {
              const project = list.find((p) => p.path === activeMenu.path);
              const isCurrent = project ? sameDir(project.path, activeWorkspace) : false;
              return (
                <>
                  <button
                    type="button"
                    className="side-menu-item"
                    onClick={() => {
                      setActiveMenu(null);
                      if (project) newChatHere(project.path, isCurrent);
                    }}
                  >
                    <IconPlus />
                    <span>New chat</span>
                  </button>
                  <button
                    type="button"
                    className="side-menu-item"
                    onClick={() => {
                      const target = project;
                      setActiveMenu(null);
                      if (target) setSettingsProject(target);
                    }}
                  >
                    <IconGear />
                    <span>Settings…</span>
                  </button>
                  <button
                    type="button"
                    className="side-menu-item"
                    onClick={() => {
                      setActiveMenu(null);
                      if (project) {
                        void navigator.clipboard.writeText(project.path);
                        toast("notice", "Project path copied to clipboard");
                      }
                    }}
                  >
                    <IconCopy />
                    <span>Copy path</span>
                  </button>
                  <button
                    type="button"
                    className="side-menu-item danger"
                    onClick={() => {
                      if (project) void handleDeleteProject(project.path);
                    }}
                  >
                    <IconTrash />
                    <span>Delete project</span>
                  </button>
                </>
              );
            })()}

            {activeMenu.type === "chat" && (() => {
              const currentChats = sameDir(activeMenu.workspace, session?.workspace)
                ? chats
                : projectChats[activeMenu.workspace] || [];
              const chat = currentChats.find((c) => c.id === activeMenu.chatId);
              const isCurrent = sameDir(activeMenu.workspace, activeWorkspace);
              return (
                <>
                  <button
                    type="button"
                    className="side-menu-item"
                    onClick={() => {
                      startRenameChat(activeMenu.workspace, chat || { id: activeMenu.chatId, title: "Chat" });
                    }}
                  >
                    <IconPencil />
                    <span>Rename</span>
                  </button>
                  <button
                    type="button"
                    className="side-menu-item"
                    onClick={() => {
                      setActiveMenu(null);
                      void navigator.clipboard.writeText(chat?.title || "Untitled chat");
                      toast("notice", "Chat title copied to clipboard");
                    }}
                  >
                    <IconCopy />
                    <span>Copy title</span>
                  </button>
                  <button
                    type="button"
                    className="side-menu-item"
                    onClick={() => {
                      setActiveMenu(null);
                      newChatHere(activeMenu.workspace, isCurrent);
                    }}
                  >
                    <IconPlus />
                    <span>New chat here</span>
                  </button>
                  <button
                    type="button"
                    className="side-menu-item danger"
                    onClick={() => void handleDeleteChat(activeMenu.workspace, activeMenu.chatId)}
                  >
                    <IconTrash />
                    <span>Delete chat</span>
                  </button>
                </>
              );
            })()}

            {activeMenu.type === "canvas" && (
              <>
                <button
                  type="button"
                  className="side-menu-item"
                  onClick={() => {
                    setActiveMenu(null);
                    setIsNewProjectModalOpen(true);
                  }}
                >
                  <IconPlus />
                  <span>Make new project…</span>
                </button>
                <button
                  type="button"
                  className="side-menu-item"
                  onClick={() => {
                    setActiveMenu(null);
                    collapseAll();
                  }}
                >
                  <IconCollapseAll />
                  <span>Collapse all</span>
                </button>
                <button
                  type="button"
                  className="side-menu-item"
                  onClick={() => {
                    setActiveMenu(null);
                    expandAll();
                  }}
                >
                  <IconChevronRight />
                  <span>Expand all</span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="hr" />
      <Meters />
      {isNewProjectModalOpen && (
        <NewProjectModal
          defaultLocation={session?.workspace ? dirname(session.workspace) : undefined}
          onClose={() => setIsNewProjectModalOpen(false)}
        />
      )}
      {settingsProject && (
        <ProjectSettingsModal
          project={settingsProject}
          onClose={() => setSettingsProject(null)}
        />
      )}
    </nav>
  );
}

function NewProjectModal({
  defaultLocation,
  onClose,
}: {
  defaultLocation?: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState(defaultLocation || "");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePickLocation = async () => {
    const picked = await window.kumo.app.pickFolder();
    if (picked) setLocation(picked);
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast("warning", "Please enter a project name");
      return;
    }
    setBusy(true);
    try {
      const res = await createProject(trimmed, location || undefined);
      if (res) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Create New Project"
      description="Create a new workspace directory for chats and tasks"
      part="new-project"
      size="sm"
      initialFocus={inputRef}
      onClose={onClose}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing && !(e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          void handleCreate();
        }
      }}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleCreate()}
            disabled={busy || !name.trim()}
          >
            Create &amp; Open
          </button>
        </>
      }
    >
      <div className="new-project-fields" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <label className="setting">
          <span className="setting-label">Project Name</span>
          <input
            ref={inputRef}
            type="text"
            className="text-input"
            placeholder="e.g. my-awesome-app"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="setting">
          <span className="setting-label">Parent Folder</span>
          <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
            <input
              type="text"
              className="text-input"
              style={{ flex: 1 }}
              placeholder="Default working directory"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
            <button type="button" className="btn" onClick={() => void handlePickLocation()}>
              Browse…
            </button>
          </div>
        </label>
      </div>
    </Modal>
  );
}

function ProjectSettingsModal({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [folders, setFolders] = useState<string[]>(project.accessibleFolders || []);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAddFolder = async () => {
    try {
      const picked = await window.kumo.app.pickFolder();
      if (picked) {
        if (sameDir(picked, project.path)) {
          toast("warning", "Folder is already the project workspace root");
          return;
        }
        if (folders.some((f) => sameDir(f, picked))) {
          toast("warning", "Folder is already in the accessible list");
          return;
        }
        setFolders((prev) => [...prev, picked]);
      }
    } catch (err) {
      toast("error", (err as Error).message);
    }
  };

  const handleRemoveFolder = (folderToRemove: string) => {
    setFolders((prev) => prev.filter((f) => !sameDir(f, folderToRemove)));
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast("warning", "Project name cannot be empty");
      return;
    }
    setSaving(true);
    try {
      await saveProjectSettings(project.path, {
        name: trimmed,
        accessibleFolders: folders,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Project Settings"
      description={project.path}
      part="project-settings"
      size="sm"
      initialFocus={inputRef}
      onClose={onClose}
      onKeyDown={(e) => {
        if (
          e.key === "Enter" &&
          !e.nativeEvent.isComposing &&
          !(e.target instanceof HTMLButtonElement) &&
          !(e.target instanceof HTMLTextAreaElement)
        ) {
          e.preventDefault();
          void handleSave();
        }
      }}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void handleSave()}
            disabled={saving || !name.trim()}
          >
            Save
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        <label className="setting">
          <span className="setting-label">Name</span>
          <input
            ref={inputRef}
            type="text"
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="setting">
          <div
            className="setting-label"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <span>Accessible Paths</span>
            <button
              type="button"
              className="btn small"
              onClick={() => void handleAddFolder()}
              style={{ display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px" }}
            >
              <IconPlus /> Add folder…
            </button>
          </div>
          <p className="small muted" style={{ margin: "2px 0 6px" }}>
            External folders that this project&apos;s models and workers can access and read.
          </p>
          <div
            className="accessible-paths-list"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              maxHeight: "180px",
              overflowY: "auto",
            }}
          >
            {folders.length === 0 ? (
              <div className="small muted" style={{ padding: "8px 4px", fontStyle: "italic" }}>
                No external paths added yet.
              </div>
            ) : (
              folders.map((folder) => (
                <div
                  key={folder}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    background: "var(--chip)",
                    borderRadius: "6px",
                    padding: "6px 8px",
                  }}
                >
                  <IconFolder />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: "12px",
                      fontFamily: "var(--font-mono)",
                    }}
                    title={folder}
                  >
                    {folder}
                  </span>
                  <button
                    type="button"
                    className="sidebar-icon-btn"
                    style={{ flexShrink: 0, width: "18px", height: "18px" }}
                    aria-label={`Remove ${folder}`}
                    onClick={() => handleRemoveFolder(folder)}
                  >
                    <IconClose />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
