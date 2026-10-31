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
 * The Electron main process: the window, pop-out workbench windows, the embedded
 * Browser WebContentsView, the engine's utility process, and the app-level
 * actions the renderer may ask for. Everything else — sessions, turns,
 * approvals, workbench files/diffs/terminals — goes straight from the renderer
 * to the engine over a MessagePort this process hands out.
 */

import {
  app,
  BrowserWindow,
  MessageChannelMain,
  Notification,
  WebContentsView,
  dialog,
  ipcMain,
  nativeTheme,
  session,
  shell,
  utilityProcess,
} from "electron";
import type { UtilityProcess } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_SCHEME, handleSceneScheme, registerSceneScheme } from "./scene-protocol";
import { ensureUserScenesDir, listUserScenes, watchUserScenes } from "./user-scenes";

const here = dirname(fileURLToPath(import.meta.url));
// In development the engine is the repository's src/. Packaging (Phase 6)
// keeps src/ outside the asar and points this at it.
const engineRoot = process.env.KUMO_ENGINE_ROOT || resolve(here, "../../../../src");

const GROUND = { dark: "#05070D", light: "#F5F6F8" } as const;

export const WORKBENCH_TABS = ["workers", "files", "diff", "terminal", "browser", "plan"] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;
let quitting = false;
let stopWatchingScenes: (() => void) | null = null;
const popoutWindows = new Map<WorkbenchTab, BrowserWindow>();
/** Shown notifications: one that gets garbage collected loses its click. */
const liveNotifications = new Set<Notification>();
let browserView: WebContentsView | null = null;
/** The window the browser view is attached to: the one showing the Browser tab. */
let browserHost: BrowserWindow | null = null;
let browserError: BrowserLoadError | null = null;
/** The main window's session: pop-outs show this one, they never start their own. */
let sharedSession: string | null = null;

registerSceneScheme();

const effectiveMode = (): "dark" | "light" => (nativeTheme.shouldUseDarkColors ? "dark" : "light");

function sendWindowState(target: BrowserWindow | null = win): void {
  if (!target || target.isDestroyed()) return;
  target.webContents.send("kumo:window-state", { maximized: target.isMaximized(), focused: target.isFocused() });
}

function sendPopoutsChanged(): void {
  const tabs = [...popoutWindows.keys()];
  if (win && !win.isDestroyed()) {
    win.webContents.send("kumo:popouts-changed", tabs);
  }
  for (const child of popoutWindows.values()) {
    if (!child.isDestroyed()) child.webContents.send("kumo:popouts-changed", tabs);
  }
}

export type BrowserLoadError = { url: string; description: string };

export type BrowserViewState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: BrowserLoadError | null;
};

/** What a pop-out asks the main window to do, because only that window can. */
export type WorkbenchMessage = { kind: "insert"; text: string } | { kind: "openFile"; path: string };

function currentBrowserState(): BrowserViewState {
  if (!browserView || browserView.webContents.isDestroyed()) {
    return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, error: null };
  }
  const wc = browserView.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    error: browserError,
  };
}

function sendBrowserState(): void {
  const state = currentBrowserState();
  if (win && !win.isDestroyed()) win.webContents.send("kumo:browser-state", state);
  const popout = popoutWindows.get("browser");
  if (popout && !popout.isDestroyed()) popout.webContents.send("kumo:browser-state", state);
}

function ensureBrowserView(): WebContentsView {
  if (browserView && !browserView.webContents.isDestroyed()) return browserView;
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:kumo-browser",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  view.setVisible(false);
  view.setBorderRadius(9);
  // In place: a page mustn't be able to open windows of the system browser.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void view.webContents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (!/^https?:\/\//i.test(url) && url !== "about:blank") {
      event.preventDefault();
    }
  });
  view.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) browserError = null;
  });
  view.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    // -3 is ERR_ABORTED: another navigation took over, nothing went wrong.
    if (!isMainFrame || code === -3) return;
    browserError = { url, description };
    sendBrowserState();
  });
  for (const evt of ["did-start-loading", "did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"] as const) {
    view.webContents.on(evt as "did-start-loading", () => sendBrowserState());
  }
  browserView = view;
  browserHost = null;
  return view;
}

/** Put the browser view in `target`. It is native, so it has to live in the window that shows it. */
function hostBrowserIn(target: BrowserWindow): WebContentsView {
  const view = ensureBrowserView();
  if (browserHost !== target) {
    releaseBrowserHost();
    target.contentView.addChildView(view);
    browserHost = target;
  }
  return view;
}

function releaseBrowserHost(): void {
  if (browserView && browserHost && !browserHost.isDestroyed()) {
    browserHost.contentView.removeChildView(browserView);
    browserView.setVisible(false);
  }
  browserHost = null;
}

/** A typed address as a URL: a bare local host means the dev server, anything else https. */
function browserUrl(raw: string): URL {
  const address = /^https?:\/\//i.test(raw)
    ? raw
    : /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#].*)?$/i.test(raw)
      ? `http://${raw}`
      : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    throw new Error(`"${raw}" isn't a valid address.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http:// and https:// addresses open in the workbench browser.");
  }
  return parsed;
}

function connectWindow(target: BrowserWindow | null): void {
  if (!engine || !target || target.isDestroyed()) return;
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: "port" }, [port1]);
  target.webContents.postMessage("kumo:engine-port", null, [port2]);
}

function connectAllWindows(): void {
  connectWindow(win);
  for (const child of popoutWindows.values()) connectWindow(child);
}

function startEngine(): void {
  engine = utilityProcess.fork(join(here, "engine-host.js"), [], {
    serviceName: "Kumo engine",
    env: { ...process.env, KUMO_ENGINE_ROOT: engineRoot },
    stdio: "inherit",
  });
  engine.on("exit", (code) => {
    engine = null;
    if (quitting) return;
    console.error(`kumo: the engine exited (code ${code}); restarting it`);
    // Sessions live in the engine; a crash loses the running turn, not the
    // chats. Restart it and give the renderer windows fresh ports.
    win?.webContents.send("kumo:engine-restarted", code);
    for (const child of popoutWindows.values()) {
      if (!child.isDestroyed()) child.webContents.send("kumo:engine-restarted", code);
    }
    startEngine();
    connectAllWindows();
  });
}

function attachWindowGuards(target: BrowserWindow): void {
  target.on("maximize", () => sendWindowState(target));
  target.on("unmaximize", () => sendWindowState(target));
  target.on("focus", () => sendWindowState(target));
  target.on("blur", () => sendWindowState(target));
  target.webContents.on("did-finish-load", () => connectWindow(target));
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  target.webContents.on("will-navigate", (event, url) => {
    if (url !== target.webContents.getURL()) event.preventDefault();
  });
  // A scene may only ever show its own page; it can't navigate its frame
  // somewhere that has network access.
  target.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !event.url.startsWith(`${SCENE_SCHEME}://`)) event.preventDefault();
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "kumo",
    backgroundColor: GROUND[effectiveMode()],
    // Frameless: the window buttons are the app's own, inside the glass title
    // bar and colored by the theme. macOS keeps its traffic lights, moved
    // into the same place.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 26, y: 27 } } : {}),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  attachWindowGuards(win);
  win.on("close", () => {
    if (browserHost === win) releaseBrowserHost();
  });
  win.on("closed", () => {
    win = null;
    for (const child of popoutWindows.values()) {
      if (!child.isDestroyed()) child.close();
    }
    popoutWindows.clear();
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

function openPopoutWindow(tab: WorkbenchTab): WorkbenchTab[] {
  const existing = popoutWindows.get(tab);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return [...popoutWindows.keys()];
  }

  const child = new BrowserWindow({
    width: 680,
    height: 760,
    minWidth: 380,
    minHeight: 360,
    show: false,
    title: `kumo · ${tab}`,
    backgroundColor: GROUND[effectiveMode()],
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 26, y: 27 } } : {}),
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  popoutWindows.set(tab, child);
  child.once("ready-to-show", () => child.show());
  attachWindowGuards(child);
  child.on("close", () => {
    // The view outlives this window: the dock takes it back.
    if (browserHost === child) releaseBrowserHost();
  });
  child.on("closed", () => {
    // Reopened while this one was closing: the entry is the new window's now.
    if (popoutWindows.get(tab) === child) popoutWindows.delete(tab);
    sendPopoutsChanged();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    const u = new URL(process.env.ELECTRON_RENDERER_URL);
    u.searchParams.set("popout", tab);
    void child.loadURL(u.toString());
  } else {
    void child.loadFile(join(here, "../renderer/index.html"), { query: { popout: tab } });
  }

  sendPopoutsChanged();
  return [...popoutWindows.keys()];
}

type WindowOp = "minimize" | "toggleMaximize" | "close" | "state";
type SceneOp = "list" | "openFolder";
type WorkbenchOp = "popout" | "closePopout" | "listPopouts" | "publishSession" | "session" | "relay";
type BrowserOp = "navigate" | "bounds" | "back" | "forward" | "reload" | "state";
type BrowserBounds = { x: number; y: number; width: number; height: number; visible: boolean };

/** Show a Windows notification, unless a Kumo window is in front and the user can already see. */
function notify(title: string, body: string): boolean {
  if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return false;
  const note = new Notification({ title, body });
  const forget = () => liveNotifications.delete(note);
  note.on("click", () => {
    forget();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  note.on("close", forget);
  liveNotifications.add(note);
  note.show();
  return true;
}

type AppRequest =
  | { action: "pickFolder" }
  | { action: "notify"; title: string; body: string }
  | { action: "setTheme"; mode: "system" | "light" | "dark" }
  | { action: "window"; op: WindowOp }
  | { action: "scenes"; op: SceneOp }
  | { action: "workbench"; op: WorkbenchOp; tab?: WorkbenchTab; sessionId?: string | null; message?: WorkbenchMessage }
  | { action: "browser"; op: BrowserOp; url?: string; bounds?: BrowserBounds };

const WINDOW_OPS: readonly string[] = ["minimize", "toggleMaximize", "close", "state"];
const SCENE_OPS: readonly string[] = ["list", "openFolder"];
const WORKBENCH_OPS: readonly string[] = ["popout", "closePopout", "listPopouts", "publishSession", "session", "relay"];
const BROWSER_OPS: readonly string[] = ["navigate", "bounds", "back", "forward", "reload", "state"];

function isWorkbenchTab(v: unknown): v is WorkbenchTab {
  return typeof v === "string" && (WORKBENCH_TABS as readonly string[]).includes(v);
}

function isWorkbenchMessage(v: unknown): v is WorkbenchMessage {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  if (m.kind === "insert") return typeof m.text === "string";
  return m.kind === "openFile" && typeof m.path === "string";
}

function isBrowserBounds(v: unknown): v is BrowserBounds {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return [b.x, b.y, b.width, b.height].every(Number.isFinite) && typeof b.visible === "boolean";
}

function isAppRequest(value: unknown): value is AppRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.action === "pickFolder") return true;
  if (v.action === "notify") return typeof v.title === "string" && typeof v.body === "string";
  if (v.action === "window") return typeof v.op === "string" && WINDOW_OPS.includes(v.op);
  if (v.action === "scenes") return typeof v.op === "string" && SCENE_OPS.includes(v.op);
  if (v.action === "workbench") {
    if (typeof v.op !== "string" || !WORKBENCH_OPS.includes(v.op)) return false;
    if (v.op === "popout" || v.op === "closePopout") return isWorkbenchTab(v.tab);
    if (v.op === "publishSession") return v.sessionId === null || typeof v.sessionId === "string";
    if (v.op === "relay") return isWorkbenchMessage(v.message);
    return true;
  }
  if (v.action === "browser") {
    if (typeof v.op !== "string" || !BROWSER_OPS.includes(v.op)) return false;
    return v.op !== "bounds" || isBrowserBounds(v.bounds);
  }
  return v.action === "setTheme" && (v.mode === "system" || v.mode === "light" || v.mode === "dark");
}

function isTrustedSender(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  if (win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) {
    return win;
  }
  for (const child of popoutWindows.values()) {
    if (!child.isDestroyed() && event.sender === child.webContents && event.senderFrame === child.webContents.mainFrame) {
      return child;
    }
  }
  return null;
}

ipcMain.handle("kumo:app", async (event, request: unknown) => {
  const senderWin = isTrustedSender(event);
  if (!senderWin) {
    throw new Error("Not allowed");
  }
  if (!isAppRequest(request)) throw new Error("Unknown request");
  if (request.action === "pickFolder") {
    const result = await dialog.showOpenDialog(senderWin, { properties: ["openDirectory"], title: "Open a project folder" });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }
  if (request.action === "notify") return notify(request.title.slice(0, 120), request.body.slice(0, 240));
  if (request.action === "window") {
    if (request.op === "minimize") senderWin.minimize();
    else if (request.op === "toggleMaximize") {
      if (senderWin.isMaximized()) senderWin.unmaximize();
      else senderWin.maximize();
    } else if (request.op === "close") senderWin.close();
    return { maximized: senderWin.isMaximized(), focused: senderWin.isFocused() };
  }
  if (request.action === "scenes") {
    if (request.op === "list") return listUserScenes();
    // openPath answers with an error message, or "" when it worked.
    const failure = await shell.openPath(ensureUserScenesDir());
    if (failure) throw new Error(failure);
    return;
  }
  if (request.action === "workbench") {
    if (request.op === "listPopouts") return [...popoutWindows.keys()];
    if (request.op === "popout" && request.tab) return openPopoutWindow(request.tab);
    if (request.op === "closePopout" && request.tab) {
      const child = popoutWindows.get(request.tab);
      if (child && !child.isDestroyed()) child.close();
      popoutWindows.delete(request.tab);
      sendPopoutsChanged();
      return [...popoutWindows.keys()];
    }
    if (request.op === "session") return sharedSession;
    if (request.op === "publishSession") {
      if (senderWin !== win) throw new Error("Only the main window has a session of its own.");
      sharedSession = request.sessionId ?? null;
      for (const child of popoutWindows.values()) {
        if (!child.isDestroyed()) child.webContents.send("kumo:workbench-session", sharedSession);
      }
      return;
    }
    if (request.op === "relay" && request.message && win && !win.isDestroyed()) {
      win.webContents.send("kumo:workbench-message", request.message);
      win.focus();
    }
    return;
  }
  if (request.action === "browser") {
    if (request.op === "state") return currentBrowserState();
    if (request.op === "bounds") {
      const b = request.bounds!;
      if (!b.visible || b.width <= 0 || b.height <= 0) {
        // Giving the tab up only hides what this window still holds: a pop-out may have taken it already.
        if (browserView && browserHost === senderWin) browserView.setVisible(false);
        return currentBrowserState();
      }
      const view = hostBrowserIn(senderWin);
      view.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      });
      view.setVisible(true);
      return currentBrowserState();
    }
    const view = ensureBrowserView();
    if (request.op === "navigate") {
      const raw = String(request.url ?? "").trim();
      if (!raw) return currentBrowserState();
      // A failed load is reported through did-fail-load and shown in the tab.
      await view.webContents.loadURL(browserUrl(raw).toString()).catch(() => {});
      sendBrowserState();
      return currentBrowserState();
    }
    if (request.op === "back" && view.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    } else if (request.op === "forward" && view.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    } else if (request.op === "reload") {
      view.webContents.reload();
    }
    sendBrowserState();
    return currentBrowserState();
  }
  nativeTheme.themeSource = request.mode;
  win?.setBackgroundColor(GROUND[effectiveMode()]);
  for (const child of popoutWindows.values()) {
    if (!child.isDestroyed()) child.setBackgroundColor(GROUND[effectiveMode()]);
  }
  return effectiveMode();
});

nativeTheme.on("updated", () => {
  win?.setBackgroundColor(GROUND[effectiveMode()]);
  for (const child of popoutWindows.values()) {
    if (!child.isDestroyed()) child.setBackgroundColor(GROUND[effectiveMode()]);
  }
});

app.whenReady().then(() => {
  // Windows names the sender of a notification by this id, and drops it without one.
  app.setAppUserModelId("com.kumo.desktop");
  // Electron grants permission requests by default. Nothing here needs a
  // device or browser permission, and theme code (Phase 3c) must not get one.
  const allowed = (permission: string) => permission === "clipboard-sanitized-write";
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission));
  const browserSes = session.fromPartition("persist:kumo-browser");
  // Any web page can load here, so it gets nothing at all.
  browserSes.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSes.setPermissionCheckHandler(() => false);
  handleSceneScheme();
  stopWatchingScenes = watchUserScenes(() => {
    if (win && !win.isDestroyed()) win.webContents.send("kumo:scenes-changed");
    for (const child of popoutWindows.values()) {
      if (!child.isDestroyed()) child.webContents.send("kumo:scenes-changed");
    }
  });
  startEngine();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Let the engine close its sessions (and their provider CLIs) before quitting;
// a hard kill skips that on Windows.
app.on("before-quit", (event) => {
  stopWatchingScenes?.();
  stopWatchingScenes = null;
  if (quitting || !engine) {
    quitting = true;
    return;
  }
  quitting = true;
  event.preventDefault();
  const proc = engine;
  const timer = setTimeout(() => proc.kill(), 3000);
  proc.once("exit", () => {
    clearTimeout(timer);
    app.quit();
  });
  proc.postMessage({ type: "shutdown" });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
