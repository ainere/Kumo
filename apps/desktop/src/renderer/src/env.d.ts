/// <reference types="vite/client" />

interface KumoBridge {
  invoke(command: string, args?: unknown): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  onEngineRestart(listener: () => void): () => void;
  app: {
    pickFolder(): Promise<string | null>;
    setTheme(mode: "system" | "light" | "dark"): Promise<"dark" | "light">;
  };
}

interface Window {
  kumo: KumoBridge;
}
