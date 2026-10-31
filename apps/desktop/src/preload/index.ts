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
 * The renderer's only door to the rest of the app. It exposes two things:
 * `kumo.invoke(command, args)` / `kumo.onEvent(cb)` over the engine's
 * MessagePort, and `kumo.app.*` for the folder picker, native theme, window
 * controls, scenes folder, workbench pop-outs and browser view.
 * The engine validates every command; nothing else is reachable from the page.
 */

import { contextBridge, ipcRenderer } from "electron";
import type { BrowserViewState, WorkbenchMessage, WorkbenchTab } from "../main/index";
import type { SceneList } from "../main/user-scenes";
import type { ThemeList } from "../main/user-themes";
import type { PanelList } from "../main/user-panels";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Request = { id: number; command: string; args: unknown };

let port: MessagePort | null = null;
let nextId = 1;
/** Sent to the current engine, waiting for its answer. */
const pending = new Map<number, Pending>();
/** Made while there was no engine port; sent when one arrives. */
const queued: Array<{ request: Request; waiting: Pending }> = [];
const listeners = new Set<(event: unknown) => void>();
const restartListeners = new Set<() => void>();

function send(request: Request, waiting: Pending): void {
  pending.set(request.id, waiting);
  port!.postMessage(request);
}

function abandonPending(): void {
  for (const { reject } of pending.values()) reject(new Error("The engine restarted"));
  pending.clear();
}

ipcRenderer.on("kumo:engine-port", (event) => {
  const fresh = event.ports[0];
  if (!fresh) return;
  // A new port means a new engine: requests sent to the old one never answer.
  abandonPending();
  port?.close();
  port = fresh;
  port.onmessage = ({ data }) => {
    if (data && typeof data === "object" && "event" in data) {
      for (const listener of listeners) listener(data.event);
      return;
    }
    const waiting = pending.get(data?.id);
    if (!waiting) return;
    pending.delete(data.id);
    if (typeof data.error === "string") waiting.reject(new Error(data.error));
    else waiting.resolve(data.result);
  };
  for (const { request, waiting } of queued.splice(0)) send(request, waiting);
});

ipcRenderer.on("kumo:engine-restarted", () => {
  // The new engine's port follows this message; until it arrives, requests
  // wait in the queue instead of going to the dead one.
  abandonPending();
  port?.close();
  port = null;
  for (const listener of restartListeners) listener();
});

type WindowState = { maximized: boolean; focused: boolean };
const windowListeners = new Set<(state: WindowState) => void>();
ipcRenderer.on("kumo:window-state", (_event, state: WindowState) => {
  for (const listener of windowListeners) listener(state);
});

const sceneListeners = new Set<() => void>();
ipcRenderer.on("kumo:scenes-changed", () => {
  for (const listener of sceneListeners) listener();
});

const themeListeners = new Set<() => void>();
ipcRenderer.on("kumo:themes-changed", () => {
  for (const listener of themeListeners) listener();
});

const panelListeners = new Set<() => void>();
ipcRenderer.on("kumo:panels-changed", () => {
  for (const listener of panelListeners) listener();
});

const popoutListeners = new Set<(tabs: WorkbenchTab[]) => void>();
ipcRenderer.on("kumo:popouts-changed", (_event, tabs: WorkbenchTab[]) => {
  for (const listener of popoutListeners) listener(tabs);
});

const browserListeners = new Set<(state: BrowserViewState) => void>();
ipcRenderer.on("kumo:browser-state", (_event, state: BrowserViewState) => {
  for (const listener of browserListeners) listener(state);
});

const sessionListeners = new Set<(sessionId: string | null) => void>();
ipcRenderer.on("kumo:workbench-session", (_event, sessionId: string | null) => {
  for (const listener of sessionListeners) listener(sessionId);
});

const messageListeners = new Set<(message: WorkbenchMessage) => void>();
ipcRenderer.on("kumo:workbench-message", (_event, message: WorkbenchMessage) => {
  for (const listener of messageListeners) listener(message);
});

contextBridge.exposeInMainWorld("kumo", {
  invoke(command: string, args?: unknown): Promise<unknown> {
    const request = { id: nextId++, command: String(command), args: args ?? {} };
    return new Promise((resolve, reject) => {
      if (port) send(request, { resolve, reject });
      else queued.push({ request, waiting: { resolve, reject } });
    });
  },
  onEvent(listener: (event: unknown) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  onEngineRestart(listener: () => void): () => void {
    restartListeners.add(listener);
    return () => restartListeners.delete(listener);
  },
  app: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke("kumo:app", { action: "pickFolder" }),
    notify: (title: string, body: string): Promise<boolean> =>
      ipcRenderer.invoke("kumo:app", { action: "notify", title, body }),
    setTheme: (mode: "system" | "light" | "dark"): Promise<"dark" | "light"> =>
      ipcRenderer.invoke("kumo:app", { action: "setTheme", mode }),
    platform: process.platform,
    window: (op: "minimize" | "toggleMaximize" | "close" | "state"): Promise<WindowState> =>
      ipcRenderer.invoke("kumo:app", { action: "window", op }),
    onWindowState(listener: (state: WindowState) => void): () => void {
      windowListeners.add(listener);
      return () => windowListeners.delete(listener);
    },
    scenes: {
      list: (): Promise<SceneList> => ipcRenderer.invoke("kumo:app", { action: "scenes", op: "list" }),
      openFolder: (): Promise<void> => ipcRenderer.invoke("kumo:app", { action: "scenes", op: "openFolder" }),
      onChanged(listener: () => void): () => void {
        sceneListeners.add(listener);
        return () => sceneListeners.delete(listener);
      },
    },
    themes: {
      list: (): Promise<ThemeList> => ipcRenderer.invoke("kumo:app", { action: "themes", op: "list" }),
      openFolder: (): Promise<void> => ipcRenderer.invoke("kumo:app", { action: "themes", op: "openFolder" }),
      onChanged(listener: () => void): () => void {
        themeListeners.add(listener);
        return () => themeListeners.delete(listener);
      },
    },
    panels: {
      list: (): Promise<PanelList> => ipcRenderer.invoke("kumo:app", { action: "panels", op: "list" }),
      openFolder: (): Promise<void> => ipcRenderer.invoke("kumo:app", { action: "panels", op: "openFolder" }),
      onChanged(listener: () => void): () => void {
        panelListeners.add(listener);
        return () => panelListeners.delete(listener);
      },
    },
    workbench: {
      popout: (tab: WorkbenchTab): Promise<WorkbenchTab[]> =>
        ipcRenderer.invoke("kumo:app", { action: "workbench", op: "popout", tab }),
      closePopout: (tab: WorkbenchTab): Promise<WorkbenchTab[]> =>
        ipcRenderer.invoke("kumo:app", { action: "workbench", op: "closePopout", tab }),
      listPopouts: (): Promise<WorkbenchTab[]> =>
        ipcRenderer.invoke("kumo:app", { action: "workbench", op: "listPopouts" }),
      onPopoutsChanged(listener: (tabs: WorkbenchTab[]) => void): () => void {
        popoutListeners.add(listener);
        return () => popoutListeners.delete(listener);
      },
      publishSession: (sessionId: string | null): Promise<void> =>
        ipcRenderer.invoke("kumo:app", { action: "workbench", op: "publishSession", sessionId }),
      session: (): Promise<string | null> => ipcRenderer.invoke("kumo:app", { action: "workbench", op: "session" }),
      onSession(listener: (sessionId: string | null) => void): () => void {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      relay: (message: WorkbenchMessage): Promise<void> =>
        ipcRenderer.invoke("kumo:app", { action: "workbench", op: "relay", message }),
      onMessage(listener: (message: WorkbenchMessage) => void): () => void {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
    },
    browser: {
      navigate: (url: string): Promise<BrowserViewState> =>
        ipcRenderer.invoke("kumo:app", { action: "browser", op: "navigate", url }),
      bounds: (bounds: { x: number; y: number; width: number; height: number; visible: boolean }): Promise<BrowserViewState> =>
        ipcRenderer.invoke("kumo:app", { action: "browser", op: "bounds", bounds }),
      back: (): Promise<BrowserViewState> => ipcRenderer.invoke("kumo:app", { action: "browser", op: "back" }),
      forward: (): Promise<BrowserViewState> => ipcRenderer.invoke("kumo:app", { action: "browser", op: "forward" }),
      reload: (): Promise<BrowserViewState> => ipcRenderer.invoke("kumo:app", { action: "browser", op: "reload" }),
      state: (): Promise<BrowserViewState> => ipcRenderer.invoke("kumo:app", { action: "browser", op: "state" }),
      onState(listener: (state: BrowserViewState) => void): () => void {
        browserListeners.add(listener);
        return () => browserListeners.delete(listener);
      },
    },
  },
});
