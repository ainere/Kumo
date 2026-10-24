// @ts-check
/**
 * commands.js — The engine's command surface for out-of-process clients.
 *
 * The desktop renderer cannot touch the engine directly: it sends
 * `{ command, args }` messages, and this router validates each one against
 * its schema before calling the Session or SessionManager. Unknown commands
 * and malformed arguments are rejected here, so a compromised or buggy
 * renderer can only do what these schemas allow.
 */

import { z } from "zod";
import { listProjects } from "../data/sessions.js";
import { VERSION } from "../version.js";
import { loadPrefs, savePrefs, PrefsSchema } from "./prefs.js";

const id = z.string().min(1).max(128);
const sessionOnly = z.object({ sessionId: id }).strict();

export const CommandSchemas = {
  "app.info": z.object({}).strict(),
  "prefs.get": z.object({}).strict(),
  "prefs.set": z.object({ patch: PrefsSchema.partial().strict() }).strict(),
  "projects.list": z.object({}).strict(),
  "session.create": z.object({ workspace: z.string().min(1).max(4096), chatId: id.optional() }).strict(),
  "session.snapshot": sessionOnly,
  "session.send": z.object({ sessionId: id, prompt: z.string().min(1).max(200_000) }).strict(),
  "session.interrupt": sessionOnly,
  "session.newChat": sessionOnly,
  "session.openChat": z.object({ sessionId: id, chatId: id }).strict(),
  "session.listChats": sessionOnly,
  "session.turnLog": sessionOnly,
  "session.setWorkspace": z.object({ sessionId: id, workspace: z.string().min(1).max(4096) }).strict(),
  "session.updateSettings": z
    .object({ sessionId: id, patch: z.record(z.string(), z.unknown()), persist: z.boolean().optional() })
    .strict(),
  "session.resolveApproval": z
    .object({ sessionId: id, approvalId: id, approved: z.boolean(), reason: z.string().max(500).optional() })
    .strict(),
  "session.exportMarkdown": z.object({ sessionId: id, filename: z.string().min(1).max(200).optional() }).strict(),
  "session.refreshQuotas": sessionOnly,
  "session.stop": sessionOnly,
};

/** @typedef {keyof typeof CommandSchemas} CommandName */

/**
 * What a client needs to draw a session it did not see start.
 *
 * @param {import("./session.js").Session} s
 */
export function sessionSnapshot(s) {
  return {
    id: s.id,
    workspace: s.workspace,
    chatId: s.chatId,
    settings: { ...s.settings },
    busy: s.busy,
    quotas: s.quotas.snapshot(),
  };
}

/**
 * @param {import("./session-manager.js").SessionManager} manager
 * @returns {(name: string, args?: unknown) => Promise<unknown>}
 */
export function createCommandRouter(manager) {
  /** @param {string} sessionId */
  const session = (sessionId) => {
    const s = manager.get(sessionId);
    if (!s) throw new Error(`No session '${sessionId}'.`);
    return s;
  };

  /** @type {Record<CommandName, (args: any) => unknown>} */
  const handlers = {
    "app.info": () => ({ version: VERSION, platform: process.platform }),
    "prefs.get": () => loadPrefs(),
    "prefs.set": ({ patch }) => savePrefs(patch),
    "projects.list": () => listProjects(),
    "session.create": async ({ workspace, chatId }) =>
      sessionSnapshot(await manager.create({ workspace, chatId, interactive: true })),
    "session.snapshot": ({ sessionId }) => sessionSnapshot(session(sessionId)),
    "session.send": ({ sessionId, prompt }) => session(sessionId).send(prompt),
    "session.interrupt": ({ sessionId }) => {
      session(sessionId).interrupt();
      return null;
    },
    "session.newChat": async ({ sessionId }) => {
      await session(sessionId).newChat();
      return sessionSnapshot(session(sessionId));
    },
    "session.openChat": ({ sessionId, chatId }) => session(sessionId).openChat(chatId),
    "session.listChats": ({ sessionId }) => session(sessionId).listChats(),
    "session.turnLog": ({ sessionId }) => session(sessionId).turnLog(),
    "session.setWorkspace": async ({ sessionId, workspace }) => {
      await session(sessionId).setWorkspace(workspace);
      return sessionSnapshot(session(sessionId));
    },
    "session.updateSettings": ({ sessionId, patch, persist }) =>
      session(sessionId).updateSettings(patch, { persist: Boolean(persist) }),
    "session.resolveApproval": ({ sessionId, approvalId, approved, reason }) =>
      session(sessionId).resolveApproval(approvalId, approved, reason),
    "session.exportMarkdown": ({ sessionId, filename }) => session(sessionId).exportMarkdown(filename),
    "session.refreshQuotas": ({ sessionId }) => session(sessionId).refreshQuotas(),
    "session.stop": async ({ sessionId }) => {
      await manager.close(sessionId);
      return null;
    },
  };

  return async function run(name, args) {
    if (!Object.hasOwn(CommandSchemas, name)) throw new Error(`Unknown command '${name}'.`);
    const command = /** @type {CommandName} */ (name);
    const parsed = CommandSchemas[command].parse(args ?? {});
    return handlers[command](parsed);
  };
}
