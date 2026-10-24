/**
 * The Electron main process: the window, the engine's utility process, and
 * the few app-level actions the renderer may ask for (folder picker, native
 * theme). Everything else — sessions, turns, approvals — goes straight from
 * the renderer to the engine over a MessagePort this process hands out.
 */

import { app, BrowserWindow, MessageChannelMain, dialog, ipcMain, nativeTheme, session, shell, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_SCHEME, handleSceneScheme, registerSceneScheme } from "./scene-protocol";

const here = dirname(fileURLToPath(import.meta.url));
// In development the engine is the repository's src/. Packaging (Phase 6)
// keeps src/ outside the asar and points this at it.
const engineRoot = process.env.KUMO_ENGINE_ROOT || resolve(here, "../../../../src");

const GROUND = { dark: "#05070D", light: "#F5F6F8" } as const;

let win: BrowserWindow | null = null;
let engine: UtilityProcess | null = null;
let quitting = false;

registerSceneScheme();

const effectiveMode = (): "dark" | "light" => (nativeTheme.shouldUseDarkColors ? "dark" : "light");

function sendWindowState(): void {
  if (!win) return;
  win.webContents.send("kumo:window-state", { maximized: win.isMaximized(), focused: win.isFocused() });
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
    // chats. Restart it and give the renderer a fresh port.
    win?.webContents.send("kumo:engine-restarted", code);
    startEngine();
    connectRenderer();
  });
}

function connectRenderer(): void {
  if (!engine || !win) return;
  const { port1, port2 } = new MessageChannelMain();
  engine.postMessage({ type: "port" }, [port1]);
  win.webContents.postMessage("kumo:engine-port", null, [port2]);
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
  win.on("maximize", sendWindowState);
  win.on("unmaximize", sendWindowState);
  win.on("focus", sendWindowState);
  win.on("blur", sendWindowState);
  win.webContents.on("did-finish-load", connectRenderer);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win?.webContents.getURL()) event.preventDefault();
  });
  // A scene may only ever show its own page; it can't navigate its frame
  // somewhere that has network access.
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !event.url.startsWith(`${SCENE_SCHEME}://`)) event.preventDefault();
  });
  win.on("closed", () => {
    win = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

type WindowOp = "minimize" | "toggleMaximize" | "close" | "state";
type AppRequest =
  | { action: "pickFolder" }
  | { action: "setTheme"; mode: "system" | "light" | "dark" }
  | { action: "window"; op: WindowOp };

const WINDOW_OPS: readonly string[] = ["minimize", "toggleMaximize", "close", "state"];

function isAppRequest(value: unknown): value is AppRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.action === "pickFolder") return true;
  if (v.action === "window") return typeof v.op === "string" && WINDOW_OPS.includes(v.op);
  return v.action === "setTheme" && (v.mode === "system" || v.mode === "light" || v.mode === "dark");
}

ipcMain.handle("kumo:app", async (event, request: unknown) => {
  // Only our own window's top frame may ask.
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error("Not allowed");
  }
  if (!isAppRequest(request)) throw new Error("Unknown request");
  if (request.action === "pickFolder") {
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Open a project folder" });
    return result.canceled ? null : result.filePaths[0] ?? null;
  }
  if (request.action === "window") {
    if (request.op === "minimize") win.minimize();
    else if (request.op === "toggleMaximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (request.op === "close") win.close();
    return { maximized: win.isMaximized(), focused: win.isFocused() };
  }
  nativeTheme.themeSource = request.mode;
  win.setBackgroundColor(GROUND[effectiveMode()]);
  return effectiveMode();
});

nativeTheme.on("updated", () => {
  win?.setBackgroundColor(GROUND[effectiveMode()]);
});

app.whenReady().then(() => {
  // Electron grants permission requests by default. Nothing here needs a
  // device or browser permission, and theme code (Phase 3c) must not get one.
  const allowed = (permission: string) => permission === "clipboard-sanitized-write";
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed(permission));
  handleSceneScheme();
  startEngine();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Let the engine close its sessions (and their provider CLIs) before quitting;
// a hard kill skips that on Windows.
app.on("before-quit", (event) => {
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
