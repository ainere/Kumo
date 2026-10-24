// @ts-check
/**
 * events.js — The engine's event contract.
 *
 * A Session reports everything as one stream of plain, serializable events:
 * the CLI renders them to the terminal, and the desktop app will send the
 * same objects across its process boundary. Each event has a `type`, the
 * `sessionId` it belongs to and a timestamp `at`.
 *
 * The zod schemas are the single definition: the JSDoc types below are
 * inferred from them, and with KUMO_STRICT_EVENTS=1 (set by the test suite)
 * every emitted event is validated, so a payload that drifts from the
 * contract fails a test instead of reaching a renderer.
 */

import { z } from "zod";

const base = { sessionId: z.string(), at: z.number() };

/** A quota snapshot as the orchestrator client reports it (see QuotaMonitor). */
const limits = z.record(z.string(), z.unknown()).nullable();

const RoleAssignmentSchema = z.object({ provider: z.string(), model: z.string(), effort: z.string().optional() });

const CustomRoleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  access: z.enum(["read", "write"]),
  provider: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

/** Per-role assignments (a missing role runs on the shared worker) and custom roles; see src/config/roles.js. */
export const RolesSchema = z.object({
  scout: RoleAssignmentSchema.optional(),
  builder: RoleAssignmentSchema.optional(),
  tester: RoleAssignmentSchema.optional(),
  researcher: RoleAssignmentSchema.optional(),
  reviewer: RoleAssignmentSchema.optional(),
  designer: RoleAssignmentSchema.optional(),
  custom: z.array(CustomRoleSchema),
});

export const SessionSettingsSchema = z.object({
  orchestratorProvider: z.string(),
  orchestratorModel: z.string(),
  reasoningEffort: z.string(),
  workerProvider: z.string(),
  workerModel: z.string(),
  workerEffort: z.string(),
  safetyMode: z.string(),
  timeoutMs: z.number(),
  turnTimeoutMs: z.number(),
  roles: RolesSchema,
});

export const EventSchemas = {
  "session.ready": z.object({
    ...base,
    type: z.literal("session.ready"),
    workspace: z.string(),
    chatId: z.string().nullable(),
    resumed: z.boolean(),
    settings: SessionSettingsSchema,
  }),
  "session.warning": z.object({ ...base, type: z.literal("session.warning"), message: z.string() }),
  "session.notice": z.object({ ...base, type: z.literal("session.notice"), message: z.string() }),
  "session.error": z.object({ ...base, type: z.literal("session.error"), message: z.string() }),
  "session.closed": z.object({ ...base, type: z.literal("session.closed") }),
  "settings.changed": z.object({
    ...base,
    type: z.literal("settings.changed"),
    settings: SessionSettingsSchema,
    changed: z.array(z.string()),
  }),
  "chat.changed": z.object({
    ...base,
    type: z.literal("chat.changed"),
    workspace: z.string(),
    chatId: z.string().nullable(),
    title: z.string(),
    resumed: z.boolean(),
  }),
  "turn.started": z.object({ ...base, type: z.literal("turn.started"), turnId: z.string(), prompt: z.string() }),
  "turn.delta": z.object({ ...base, type: z.literal("turn.delta"), turnId: z.string(), text: z.string() }),
  // An empty `text` means "still thinking" (a heartbeat with nothing to show).
  "turn.reasoning": z.object({ ...base, type: z.literal("turn.reasoning"), turnId: z.string(), text: z.string() }),
  "turn.completed": z.object({
    ...base,
    type: z.literal("turn.completed"),
    turnId: z.string(),
    text: z.string(),
    elapsedMs: z.number(),
  }),
  "turn.failed": z.object({
    ...base,
    type: z.literal("turn.failed"),
    turnId: z.string(),
    reason: z.string(),
    elapsedMs: z.number(),
    interrupted: z.boolean(),
    timedOut: z.boolean(),
  }),
  "tool.started": z.object({
    ...base,
    type: z.literal("tool.started"),
    turnId: z.string().nullable(),
    toolId: z.string(),
    name: z.string(),
    // The role the tool belongs to (scout, builder, …, or a custom role's id); null for other tools.
    role: z.string().nullable(),
    task: z.string(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    startedAt: z.number(),
  }),
  "tool.output": z.object({ ...base, type: z.literal("tool.output"), toolId: z.string(), text: z.string() }),
  "tool.completed": z.object({
    ...base,
    type: z.literal("tool.completed"),
    toolId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    elapsedMs: z.number(),
  }),
  "approval.requested": z.object({
    ...base,
    type: z.literal("approval.requested"),
    approvalId: z.string(),
    // "write": a worker change waiting in interactive safety mode.
    // "orchestrator": the orchestrator CLI itself asks (e.g. Codex wants to run a command).
    kind: z.enum(["write", "orchestrator"]),
    tool: z.string(),
    preview: z.string(),
  }),
  "approval.resolved": z.object({
    ...base,
    type: z.literal("approval.resolved"),
    approvalId: z.string(),
    approved: z.boolean(),
    reason: z.string().optional(),
  }),
  "quota.updated": z.object({
    ...base,
    type: z.literal("quota.updated"),
    orchestrator: limits,
    antigravity: limits,
  }),
};

/** @typedef {keyof typeof EventSchemas} EventType */
/** @typedef {z.infer<typeof SessionSettingsSchema>} SessionSettings */
/**
 * @template {EventType} T
 * @typedef {z.infer<(typeof EventSchemas)[T]>} EventOf
 */
/** @typedef {{ [T in EventType]: EventOf<T> }[EventType]} KumoEvent */

export const EVENT_TYPES = /** @type {EventType[]} */ (Object.keys(EventSchemas));

/** Whether emitted events are validated (on in tests, off in normal runs for speed). */
export function strictEvents() {
  return process.env.KUMO_STRICT_EVENTS === "1";
}

/**
 * Build an event, validating it in strict mode.
 *
 * @template {EventType} T
 * @param {T} type
 * @param {string} sessionId
 * @param {Omit<EventOf<T>, "type" | "sessionId" | "at">} payload
 * @returns {EventOf<T>}
 */
export function makeEvent(type, sessionId, payload) {
  const event = /** @type {EventOf<T>} */ ({ ...payload, type, sessionId, at: Date.now() });
  if (strictEvents()) EventSchemas[type].parse(event);
  return event;
}
