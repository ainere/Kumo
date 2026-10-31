// The engine's event contract and settings, typed from src/core (JSDoc + zod).
import type { KumoEvent, SessionSettings } from "../../../../../src/core/events.js";
import type { Prefs } from "../../../../../src/core/prefs.js";

export type { KumoEvent, SessionSettings, Prefs };

export type Limits = Record<string, unknown> | null;
/**
 * What the engine knows of usage. `providers` holds every account's limits
 * (Antigravity's are `antigravity`); `active` names the providers in use, the
 * lead first, with or without a reading yet.
 */
export type Quotas = { orchestrator: Limits; antigravity: Limits; providers?: Record<string, Limits>; active?: string[] };

export interface SessionSnapshot {
  id: string;
  workspace: string;
  chatId: string | null;
  settings: SessionSettings;
  busy: boolean;
  quotas: Quotas;
}

export interface Project {
  path: string;
  name: string;
  order?: number;
  lastOpened?: number;
  accessibleFolders?: string[];
}

export interface Chat {
  id: string;
  title: string;
  order?: number;
  lastUsedAt?: number;
  turns?: number;
  /** The lead's provider when the chat last ran a turn. */
  provider?: string;
}

/** One worker call as the turn log keeps it. */
export interface TurnTool {
  toolId: string;
  name: string;
  role: string | null;
  task: string;
  model: string | null;
  effort: string | null;
  ok: boolean | null;
  elapsedMs: number | null;
  /** The worker's output, trimmed to its last part. */
  output: string;
}

export interface Turn {
  prompt: string;
  responseSummary: string | null;
  timestamp: number;
  elapsedMs?: number;
  model?: string;
  provider?: string;
  /** The lead's reasoning text, when its provider streams it. */
  reasoning?: string;
  tools?: TurnTool[];
  /** Workspace-relative paths of files the turn's approved diffs changed. */
  diffPaths?: string[];
  /** This turn began on a provider other than the chat's earlier turns, with them replayed into its context. */
  replayed?: boolean;
}

// ── Settings: accounts, models, doctor (src/core/accounts.js, catalog.js, doctor.js) ──

export type AccountKind = "subscription" | "api" | "local";

/** One provider as Settings › Accounts shows it. Never carries a key or token. */
export interface AccountStatus {
  /** Canonical provider id (claude, codex, antigravity, …). */
  provider: string;
  name: string;
  kind: AccountKind;
  /** The CLI was found; true for API providers. */
  installed: boolean;
  version: string | null;
  /** Signed in (subscription), key present (api), running (local); null when the CLI can't tell. */
  signedIn: boolean | null;
  /** The account's email or organisation, when the CLI reports one. */
  account: string | null;
  /** "Claude Pro", "ChatGPT Plus", "Google AI Pro", … when known. */
  plan: string | null;
  /** One line for people: "Logged in using ChatGPT", "OPENAI_API_KEY is set", "agy not found". */
  detail: string;
  canSignIn: boolean;
  canSignOut: boolean;
  /** API providers: the variable that was found or is expected. Never its value. */
  envVar: string | null;
  /** compat-api and ollama: the base URL in use. */
  baseUrl: string | null;
}

export interface SignInResult {
  launched: boolean;
  /** The command the new terminal runs, for the UI to show ("claude auth login"). */
  command: string;
}

export interface EndpointTest {
  ok: boolean;
  detail: string;
  models: string[];
}

export interface CatalogModel {
  id: string;
  name: string;
  desc: string | null;
  alias: string | null;
  /** Reasoning efforts this model takes; empty when it picks its own. */
  efforts: string[];
  defaultEffort: string | null;
  /** Only when the provider reports it; never guessed. */
  contextWindow: number | null;
  inputModalities: string[] | null;
}

export interface CatalogProvider {
  provider: string;
  name: string;
  kind: AccountKind;
  /** Usable now: signed in, key present or running. */
  available: boolean;
  /** Can run write roles (builder, tester, designer, write custom roles). */
  canWrite: boolean;
  /** Can be the lead: calls Kumo's worker tools. */
  canLead: boolean;
  /** "live" when the provider listed its own models, else Kumo's catalog. */
  source: "live" | "catalog";
  models: CatalogModel[];
}

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  group: "runtime" | "providers" | "bridge" | "permissions";
  label: string;
  status: DoctorStatus;
  detail: string;
  /** A safe, repeatable fix the app can run. */
  repair: { id: string; label: string } | null;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ranAt: number;
}

export interface RepairResult {
  ok: boolean;
  detail: string;
  checks: DoctorCheck[];
}

/** The saved defaults (config.json) a new session starts from. */
export interface GlobalConfig {
  settings: SessionSettings;
  compatBaseUrl: string;
  openaiBaseUrl: string;
  anthropicBaseUrl: string;
  geminiBaseUrl: string;
  /** What the lead calls the user; empty when unset. A saved default of its own, not a session setting. */
  userName: string;
  /** Standing instructions for the lead and every worker; empty when unset. */
  customInstructions: string;
}

/** A scene script in the user's scenes folder (main process, scene-protocol.ts). */
export interface SceneFile {
  /** File name, e.g. "sharks.ts". */
  file: string;
  /** The path the scene page serves it at, e.g. "/user/sharks.ts". */
  src: string;
  kind: "js" | "ts";
  /** Why it can't run (a TypeScript error, too large), else null. */
  error: string | null;
  mtime: number;
}

export type SettingsTab = "accounts" | "models" | "roles" | "appearance" | "general" | "doctor";

export interface TurnOutcome {
  ok: boolean;
  reason?: string;
  text: string;
  elapsedMs: number;
  interrupted: boolean;
  timedOut: boolean;
}

export interface ToolView {
  toolId: string;
  turnId: string | null;
  name: string;
  /** The role the tool belongs to (scout, builder, …, or a custom role's id); null for other tools. */
  role: string | null;
  task: string;
  model: string | null;
  effort: string | null;
  status: "running" | "done" | "failed";
  startedAt: number;
  elapsedMs: number | null;
  output: string;
}

/** A lead answer in the order it happened: text, worker calls, more text. */
export type MessagePart = { kind: "text"; text: string } | { kind: "tool"; toolId: string };

export interface Message {
  id: string;
  kind: "user" | "lead";
  /** The whole text, without the tool calls. */
  text: string;
  parts: MessagePart[];
  turnId: string | null;
  streaming: boolean;
  thinking: boolean;
  failed: string | null;
}

export interface Approval {
  approvalId: string;
  kind: "write" | "orchestrator";
  tool: string;
  preview: string;
}

export interface Toast {
  id: number;
  kind: "warning" | "notice" | "error";
  text: string;
}
