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
  };
}

interface Window {
  kumo: KumoBridge;
}
