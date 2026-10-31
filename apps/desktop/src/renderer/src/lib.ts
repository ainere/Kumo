import { useEffect, useState } from "react";

export const basename = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
export const dirname = (path: string): string => path.replace(/[\\/]+[^\\/]+[\\/]*$/, "") || path;

/** Workspace paths from different sources: compare without case or slash style (Windows). */
const normDir = (path: string) => path.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
function fileMatch(path: string, name: string, query: string): number | null {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.includes(query)) return 3;
  let at = -1;
  for (const ch of query) {
    at = path.indexOf(ch, at + 1);
    if (at === -1) return null;
  }
  return 4;
}

/**
 * The best matches for what was typed: the file's name over its folders, the
 * start of a name over the middle, and letters in order ("wbjs" finds
 * workbench.js) last. Shorter paths win ties.
 */
export function rankFiles<T extends { path: string; name: string }>(files: T[], query: string, limit: number): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return files.slice(0, limit);
  const scored: Array<{ file: T; score: number }> = [];
  for (const file of files) {
    const score = fileMatch(file.path.toLowerCase(), file.name.toLowerCase(), q);
    if (score !== null) scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.path.length - b.file.path.length);
  return scored.slice(0, limit).map((s) => s.file);
}

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
  opencode: "OpenCode",
  commandcode: "CommandCode",
  copilot: "Copilot CLI",
  cursor: "Cursor",
  ollama: "Ollama",
};
export const providerLabel = (provider: string | null | undefined): string =>
  provider ? (PROVIDERS[provider] ?? provider) : "";

const KNOWN_MODEL_NAMES: Record<string, string> = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-opus-5": "Claude Opus 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
};

/** Formats a model ID into a user-friendly name without provider prefixes. */
export function modelDisplayName(id: string | null | undefined): string {
  if (!id) return "Model";
  if (KNOWN_MODEL_NAMES[id]) return KNOWN_MODEL_NAMES[id];
  return id
    .split("-")
    .map((part) => (/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/ (\d+) (\d+)/g, " $1.$2");
}

export type SafetyMode = "interactive" | "diff-review" | "autonomous";

export interface SafetyModeOption {
  id: SafetyMode;
  label: string;
  shortLabel: string;
  desc: string;
  iconType: "review" | "copilot" | "autopilot";
}

export const SAFETY_MODE_OPTIONS: SafetyModeOption[] = [
  {
    id: "interactive",
    label: "Hands-On",
    shortLabel: "Hands-On",
    desc: "You approve each file change: workers show the diff first, and nothing is written until you say yes.",
    iconType: "review",
  },
  {
    id: "diff-review",
    label: "Co-Pilot",
    shortLabel: "Co-Pilot",
    desc: "Workers show the diff first and the lead reviews it before it's applied. You aren't asked.",
    iconType: "copilot",
  },
  {
    id: "autonomous",
    label: "Autopilot",
    shortLabel: "Autopilot",
    desc: "Workers apply file changes directly, then report what changed.",
    iconType: "autopilot",
  },
];

/** The option for a mode; a value the engine wouldn't know reads as Co-Pilot, as the engine treats it, never as Autopilot. */
export function getSafetyModeOption(mode: string | null | undefined): SafetyModeOption {
  const norm = String(mode ?? "").toLowerCase().trim();
  return SAFETY_MODE_OPTIONS.find((opt) => opt.id === norm) || SAFETY_MODE_OPTIONS[1];
}

/** The built-in worker roles, in the order Kumo lists them. */
export const BUILTIN_ROLES = ["scout", "builder", "tester", "researcher", "reviewer", "designer"] as const;

/** "builder" → "Builder"; a custom role's own name; null (a tool outside any role) → "Other". */
export function roleLabel(role: string | null, custom?: ReadonlyArray<{ id: string; name?: string }>): string {
  if (role === null) return "Other";
  if ((BUILTIN_ROLES as readonly string[]).includes(role)) return role[0].toUpperCase() + role.slice(1);
  return custom?.find((c) => c.id === role)?.name || role;
}

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
