import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  closePalette,
  insertIntoComposer,
  invoke,
  closeSession,
  newChat,
  newSession,
  openNewWindow,
  openPalette,
  openSettings,
  openWorkspaceFile,
  pickAndOpenFolder,
  popoutWorkbenchTab,
  refreshQuotas,
  savePrefs,
  setWorkbenchTab,
  switchSession,
  toast,
  toastFailure,
  toggleWorkbenchSplit,
  toggleWorkbenchVisible,
  useStore,
  workbenchVisible,
} from "../store";
import { useAppliedTheme } from "../theme";
import { hasOpenDialog } from "./settings/controls";
import { useWorkbenchTabs, workbenchTabLabel } from "./workbench/Workbench";
import { useFileSearch } from "./workbench/useFileSearch";

const isMac = window.kumo.app.platform === "darwin";
const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);

const MAX_FILE_RESULTS = 80;

interface CommandItem {
  id: string;
  group: string;
  label: string;
  /** A keyboard shortcut, when there is one. */
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const mode = useStore((s) => s.paletteMode);
  const phase = useStore((s) => s.phase);
  const prefs = useStore((s) => s.prefs);
  const session = useStore((s) => s.session);
  const visible = useStore(workbenchVisible);
  const appliedTheme = useAppliedTheme();
  const tabs = useWorkbenchTabs();
  const background = useStore((s) => s.backgroundSessions);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mod || e.altKey || hasOpenDialog()) return;
      const key = e.key.toLowerCase();
      if (e.shiftKey) {
        if (key === "n") {
          e.preventDefault();
          openNewWindow();
        }
        return;
      }
      if (key === "k") {
        if (phase !== "ready" && phase !== "no-project") return;
        e.preventDefault();
        if (mode === "commands") closePalette();
        else openPalette("commands");
      } else if (key === "p") {
        if (phase !== "ready") return;
        e.preventDefault();
        if (mode === "files") closePalette();
        else openPalette("files");
      } else if (key === "b") {
        if (phase !== "ready") return;
        e.preventDefault();
        toggleWorkbenchVisible();
      } else if (key === "t") {
        if (phase !== "ready") return;
        e.preventDefault();
        void newSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, phase]);

  // Focus moves in the same tick the palette opens, so nothing typed right after goes astray.
  const open = mode !== null;
  useLayoutEffect(() => {
    if (open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return () => {
        if (returnTo.current?.isConnected) returnTo.current.focus({ preventScroll: true });
      };
    }
  }, [open]);

  useLayoutEffect(() => {
    if (mode === null) return;
    setQuery("");
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, [mode]);

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];
    if (session) {
      const current = prefs?.workbenchTab ?? "workers";
      for (const t of tabs) {
        items.push({ id: `wb-${t.id}`, group: "Workbench", label: `Open ${t.label}`, run: () => setWorkbenchTab(t.id) });
      }
      items.push(
        {
          id: "wb-toggle",
          group: "Workbench",
          label: visible ? "Hide Workbench" : "Show Workbench",
          hint: shortcut("B"),
          run: () => toggleWorkbenchVisible(),
        },
        {
          id: "wb-split",
          group: "Workbench",
          label: prefs?.workbenchSplitTab ? "Close Split View" : "Split in Two",
          run: () => toggleWorkbenchSplit(),
        },
        {
          id: "wb-popout",
          group: "Workbench",
          label: `Pop Out ${workbenchTabLabel(current)}`,
          run: () => void popoutWorkbenchTab(current),
        },
        { id: "dock-right", group: "Workbench", label: "Dock Right", run: () => void savePrefs({ dock: "right" }) },
        { id: "dock-bottom", group: "Workbench", label: "Dock Bottom", run: () => void savePrefs({ dock: "bottom" }) },
        { id: "dock-floating", group: "Workbench", label: "Float Panel", run: () => void savePrefs({ dock: "floating" }) },
        { id: "quick-open", group: "Files", label: "Quick Open…", hint: shortcut("P"), run: () => openPalette("files") },
        { id: "new-session", group: "Session", label: "New Session", hint: shortcut("T"), run: () => void newSession() },
        ...background.map((s): CommandItem => ({
          id: `session-${s.id}`,
          group: "Session",
          label: `Switch to ${s.title}${s.waiting > 0 ? " (approval waiting)" : s.busy ? " (working)" : ""}`,
          run: () => switchSession(s.id),
        })),
        ...(background.length > 0
          ? [{ id: "close-session", group: "Session", label: "Close This Session", run: () => void closeSession() }]
          : []),
        { id: "new-chat", group: "Chat", label: "New Chat", run: () => void newChat() },
        {
          id: "export-md",
          group: "Chat",
          label: "Export to Markdown",
          run: () => {
            void invoke<{ path: string }>("session.exportMarkdown", { sessionId: session.id })
              .then((res) => toast("notice", `Exported to ${res.path}`))
              .catch((err) => toastFailure(err));
          },
        }
      );
    }
    items.push(
      { id: "open-folder", group: "Project", label: "Open Folder…", run: () => void pickAndOpenFolder() },
      { id: "new-window", group: "Window", label: "New Window", hint: shortcut("Shift+N"), run: () => openNewWindow() },
      { id: "refresh-quotas", group: "Usage", label: "Refresh Usage", run: () => void refreshQuotas() },
      {
        id: "theme-toggle",
        group: "Appearance",
        label: `Switch to ${appliedTheme.mode === "dark" ? "Light" : "Dark"} Mode`,
        run: () => void savePrefs({ mode: appliedTheme.mode === "dark" ? "light" : "dark" }),
      },
      { id: "settings-accounts", group: "Settings", label: "Accounts", hint: shortcut(","), run: () => openSettings("accounts") },
      { id: "settings-models", group: "Settings", label: "Models", run: () => openSettings("models") },
      { id: "settings-roles", group: "Settings", label: "Roles", run: () => openSettings("roles") },
      { id: "settings-appearance", group: "Settings", label: "Appearance", run: () => openSettings("appearance") },
      { id: "settings-general", group: "Settings", label: "General", run: () => openSettings("general") },
      { id: "settings-doctor", group: "Settings", label: "Doctor", run: () => openSettings("doctor") }
    );
    return items;
  }, [prefs?.workbenchSplitTab, prefs?.workbenchTab, session, appliedTheme.mode, visible, tabs, background]);

  const filteredCommands = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q));
  }, [commands, query]);

  const filteredFiles = useFileSearch(mode === "files" ? query : null, MAX_FILE_RESULTS);

  const count = mode === "files" ? filteredFiles.length : filteredCommands.length;
  const clampedIndex = count === 0 ? 0 : Math.min(selectedIndex, count - 1);

  useLayoutEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [clampedIndex, mode, query]);

  if (mode === null) return null;

  const executeAt = (idx: number, mentionOnly = false) => {
    if (mode === "files") {
      const target = filteredFiles[idx];
      if (!target) return;
      closePalette();
      if (mentionOnly) insertIntoComposer(`@${target.path} `);
      else void openWorkspaceFile(target.path, true);
      return;
    }
    const cmd = filteredCommands[idx];
    if (!cmd) return;
    closePalette();
    cmd.run();
  };

  return (
    <div
      className="palette-backdrop"
      data-part="command-palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closePalette();
      }}
    >
      <div
        className="palette-modal menu-surface"
        data-part="command-palette"
        data-mode={mode}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Quick open file" : "Command palette"}
      >
        <div className="palette-head">
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={count > 0 ? `palette-option-${clampedIndex}` : undefined}
            aria-label={mode === "files" ? "Quick open file" : "Type a command"}
            placeholder={mode === "files" ? "Search files…" : "Type a command…"}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closePalette();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                if (count > 0) setSelectedIndex((clampedIndex + 1) % count);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (count > 0) setSelectedIndex((clampedIndex - 1 + count) % count);
              } else if (e.key === "Enter") {
                e.preventDefault();
                executeAt(clampedIndex, e.altKey);
              }
            }}
          />
          <div className="palette-modes">
            <button
              type="button"
              className="palette-mode"
              data-active={mode === "commands"}
              onClick={() => openPalette("commands")}
            >
              Commands
            </button>
            <button
              type="button"
              className="palette-mode"
              data-active={mode === "files"}
              onClick={() => openPalette("files")}
            >
              Files
            </button>
          </div>
        </div>

        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {count === 0 && <div className="muted small wb-empty-note">Nothing matches.</div>}
          {mode === "commands"
            ? filteredCommands.map((cmd, idx) => (
                <Fragment key={cmd.id}>
                  {cmd.group !== filteredCommands[idx - 1]?.group && <div className="palette-group">{cmd.group}</div>}
                  <button
                    type="button"
                    id={`palette-option-${idx}`}
                    role="option"
                    aria-selected={idx === clampedIndex}
                    className="palette-item"
                    data-part="palette-item"
                    data-selected={idx === clampedIndex}
                    onMouseMove={() => setSelectedIndex(idx)}
                    onClick={() => executeAt(idx)}
                  >
                    <span className="palette-item-label">{cmd.label}</span>
                    <span className="spacer" />
                    {cmd.hint && <kbd className="palette-item-kbd">{cmd.hint}</kbd>}
                  </button>
                </Fragment>
              ))
            : filteredFiles.map((file, idx) => (
                <div
                  key={file.path}
                  id={`palette-option-${idx}`}
                  role="option"
                  aria-selected={idx === clampedIndex}
                  className="palette-item"
                  data-part="palette-file-item"
                  data-selected={idx === clampedIndex}
                  title={file.path}
                  onMouseMove={() => setSelectedIndex(idx)}
                  onClick={() => executeAt(idx)}
                >
                  <span className="palette-item-label">{file.name}</span>
                  <span className="palette-item-dir">{file.path.slice(0, -file.name.length - 1)}</span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="wb-mini-btn palette-item-action"
                    onClick={(e) => {
                      e.stopPropagation();
                      executeAt(idx, true);
                    }}
                  >
                    @ Mention
                  </button>
                </div>
              ))}
        </div>

        {mode === "files" && (
          <div className="palette-foot">
            <span>↵ open</span>
            <span>Alt+↵ mention</span>
            <span>esc close</span>
          </div>
        )}
      </div>
    </div>
  );
}
