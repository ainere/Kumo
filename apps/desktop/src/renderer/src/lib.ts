import { useEffect, useState } from "react";

export const basename = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** Workspace paths from different sources: compare without case or slash style (Windows). */
const normDir = (path: string) => path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
export const sameDir = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && normDir(a) === normDir(b));

const PROVIDERS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  agy: "Antigravity",
  antigravity: "Antigravity",
  "openai-api": "OpenAI API",
  "anthropic-api": "Anthropic API",
  "gemini-api": "Gemini API",
  "compat-api": "Compatible API",
};
export const providerLabel = (provider: string | null | undefined): string =>
  provider ? (PROVIDERS[provider] ?? provider) : "";

/** "mcp__kumo-bridge__worker_implement" → "implement". */
export const toolLabel = (name: string): string => name.replace(/^.*(__|\.)/, "").replace(/^worker_/, "");

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The current time, ticking each second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
