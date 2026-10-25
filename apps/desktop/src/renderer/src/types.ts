// The engine's event contract and settings, typed from src/core (JSDoc + zod).
import type { KumoEvent, SessionSettings } from "../../../../../src/core/events.js";
import type { Prefs } from "../../../../../src/core/prefs.js";

export type { KumoEvent, SessionSettings, Prefs };

export type Limits = Record<string, unknown> | null;
export type Quotas = { orchestrator: Limits; antigravity: Limits; providers?: Record<string, Limits> };

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
  lastOpened?: number;
}

export interface Chat {
  id: string;
  title: string;
  lastUsedAt?: number;
  turns?: number;
}

export interface Turn {
  prompt: string;
  responseSummary: string | null;
  timestamp: number;
  elapsedMs?: number;
}

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
