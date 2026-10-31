/// <reference types="vite/client" />

interface KumoBridge {
  invoke(command: string, args?: unknown): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  onEngineRestart(listener: () => void): () => void;
  app: {
    pickFolder(): Promise<string | null>;
    /** A Windows notification; resolves false when a Kumo window is in front, so none was shown. */
    notify(title: string, body: string): Promise<boolean>;
    setTheme(mode: "system" | "light" | "dark"): Promise<"dark" | "light">;
    platform: string;
    window(op: "minimize" | "toggleMaximize" | "close" | "state"): Promise<{ maximized: boolean; focused: boolean }>;
    onWindowState(listener: (state: { maximized: boolean; focused: boolean }) => void): () => void;
    scenes: {
      /** The user's scenes folder (created if missing) and the scene files in it. */
      list(): Promise<{ dir: string; files: import("./types").SceneFile[] }>;
      /** Opens the scenes folder in the system file manager. */
      openFolder(): Promise<void>;
      /** A scene file was added, changed or removed; the scene page serves the new set. */
      onChanged(listener: () => void): () => void;
    };
    themes: {
      /** The user's themes folder (created if missing) and the packages in it. */
      list(): Promise<import("./types").ThemeList>;
      /** Opens the themes folder in the system file manager. */
      openFolder(): Promise<void>;
      /** Something in the themes folder changed. */
      onChanged(listener: () => void): () => void;
    };
    panels: {
      /** The user's panels folder (created if missing) and the panels in it. */
      list(): Promise<import("./types").PanelList>;
      /** Opens the panels folder in the system file manager. */
      openFolder(): Promise<void>;
      /** Something in the panels folder changed. */
      onChanged(listener: () => void): () => void;
    };
    workbench: {
      popout(tab: import("./types").WorkbenchTab): Promise<import("./types").WorkbenchTab[]>;
      closePopout(tab: import("./types").WorkbenchTab): Promise<import("./types").WorkbenchTab[]>;
      listPopouts(): Promise<import("./types").WorkbenchTab[]>;
      onPopoutsChanged(listener: (tabs: import("./types").WorkbenchTab[]) => void): () => void;
      /** The main window says which session the pop-outs show. */
      publishSession(sessionId: string | null): Promise<void>;
      session(): Promise<string | null>;
      onSession(listener: (sessionId: string | null) => void): () => void;
      /** A pop-out hands the main window something only it can do. */
      relay(message: import("./types").WorkbenchMessage): Promise<void>;
      onMessage(listener: (message: import("./types").WorkbenchMessage) => void): () => void;
    };
    browser: {
      navigate(url: string): Promise<import("./types").BrowserViewState>;
      bounds(bounds: { x: number; y: number; width: number; height: number; visible: boolean }): Promise<import("./types").BrowserViewState>;
      back(): Promise<import("./types").BrowserViewState>;
      forward(): Promise<import("./types").BrowserViewState>;
      reload(): Promise<import("./types").BrowserViewState>;
      state(): Promise<import("./types").BrowserViewState>;
      onState(listener: (state: import("./types").BrowserViewState) => void): () => void;
    };
  };
}

interface Window {
  kumo: KumoBridge;
}
