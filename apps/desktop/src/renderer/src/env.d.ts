/// <reference types="vite/client" />

interface KumoBridge {
  invoke(command: string, args?: unknown): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  onEngineRestart(listener: () => void): () => void;
  app: {
    pickFolder(): Promise<string | null>;
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
  };
}

interface Window {
  kumo: KumoBridge;
}
