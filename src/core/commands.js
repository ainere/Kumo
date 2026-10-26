/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

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

import path from "node:path";
import { z } from "zod";
import {
  listProjects,
  projectNameProblem,
  reorderProjects,
  renameProject,
  removeProject,
  createProject,
  setAccessibleFolders,
  addAccessibleFolder,
  removeAccessibleFolder,
  listChats,
  renameChat,
  deleteChat,
  moveChat,
  reorderChats,
} from "../data/sessions.js";
import { VERSION } from "../version.js";
import { loadPrefs, savePrefs, PrefsSchema } from "./prefs.js";
import { listAccounts, signIn, signOut, testEndpoint } from "./accounts.js";
import { getCatalog } from "./catalog.js";
import { runDoctor, repairDoctor, doctorReport } from "./doctor.js";
import { SESSION_SETTING_KEYS, snapshotSettings } from "./settings.js";
import { QuotaMonitor } from "./quota-monitor.js";
import { loadConfig, setConfigValue, normalizeConfigValue, ALLOWED_PROVIDERS } from "../config/settings.js";
import { modelBelongsElsewhere, resolveModel } from "../config/models.js";
import { KNOWN_ORCHESTRATORS, orchestratorDelegates } from "../providers/orchestrators/registry.js";

const id = z.string().min(1).max(128);
const sessionOnly = z.object({ sessionId: id }).strict();

/** Names Windows treats as devices, with or without an extension (`con.md` is the console). */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Whether `name` is one plain Markdown file name and not a path: no
 * separators, drive or stream colons, `..`, leading dot, control characters,
 * Windows device names, or a stem that Windows would trim.
 *
 * @param {string} name
 */
function isSafeExportName(name) {
  if (!/\.md$/i.test(name) || name.startsWith(".") || name.includes("..")) return false;
  if (/[\\/:*?"<>|]/.test(name)) return false;
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20)) return false;
  const stem = name.slice(0, -".md".length);
  if (/[. ]$/.test(stem)) return false;
  return !WINDOWS_DEVICE_NAME.test(name.split(".")[0].trimEnd());
}

/** A file name the renderer may ask for: it picks the name, never the folder. */
const exportFilename = z
  .string()
  .min(1)
  .max(200)
  .refine(isSafeExportName, "must be a plain file name ending in .md (no folders, no leading dot)");

/** The base-URL defaults Settings › Models edits, besides the session settings. */
const BASE_URL_KEYS = ["compatBaseUrl", "openaiBaseUrl", "anthropicBaseUrl", "geminiBaseUrl"];

/** Every key `config.update` accepts. */
const CONFIG_UPDATE_KEYS = [...SESSION_SETTING_KEYS, ...BASE_URL_KEYS];

/** The saved defaults (config.json) a new session starts from. */
function globalConfig() {
  const config = loadConfig();
  return {
    settings: snapshotSettings(config),
    compatBaseUrl: String(config.compatBaseUrl ?? ""),
    openaiBaseUrl: String(config.openaiBaseUrl ?? ""),
    anthropicBaseUrl: String(config.anthropicBaseUrl ?? ""),
    geminiBaseUrl: String(config.geminiBaseUrl ?? ""),
  };
}

/**
 * Validate a patch to the saved defaults and write it. Every value is checked
 * before any is written, so a bad one leaves the file as it was.
 *
 * @param {Record<string, unknown>} patch
 */
function updateGlobalConfig(patch) {
  /** @type {Record<string, any>} */
  const next = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    if (!CONFIG_UPDATE_KEYS.includes(key)) {
      throw new Error(`'${key}' is not a saved default the app can change. Allowed: ${CONFIG_UPDATE_KEYS.join(", ")}`);
    }
    next[key] = normalizeConfigValue(key, raw);
  }

  // What `kumo role set lead` enforces: only a provider that calls Kumo's worker tools can lead.
  if ("orchestratorProvider" in next || "orchestratorModel" in next) {
    const current = loadConfig();
    const provider = next.orchestratorProvider ?? current.orchestratorProvider;
    const model = resolveModel(next.orchestratorModel ?? current.orchestratorModel);
    if ("orchestratorProvider" in next && !orchestratorDelegates(provider)) {
      const leads = KNOWN_ORCHESTRATORS.filter((p) => ALLOWED_PROVIDERS.includes(p) && orchestratorDelegates(p));
      throw new Error(`${provider} cannot call Kumo's worker tools, so it cannot lead. Leads: ${leads.join(", ")}.`);
    }
    const elsewhere = modelBelongsElsewhere(provider, model);
    if (elsewhere) throw new Error(`${provider} does not offer ${model}; use provider ${elsewhere}.`);
  }

  for (const [key, value] of Object.entries(next)) setConfigValue(key, value);
  return globalConfig();
}

/** A provider id from the renderer; the engine checks it against its own table. */
const providerArg = z.string().min(1).max(64);
const refreshOnly = z.object({ refresh: z.boolean().optional() }).strict();
/** The doctor's workspace-specific checks (worker logs) run only when one is open. */
const doctorOpts = z.object({ workspace: z.string().min(1).max(4096).optional() }).strict();

export const CommandSchemas = {
  "app.info": z.object({}).strict(),
  "prefs.get": z.object({}).strict(),
  "prefs.set": z.object({ patch: PrefsSchema.partial().strict() }).strict(),
  "projects.list": z.object({}).strict(),
  "projects.listChats": z.object({ workspace: z.string().min(1).max(4096) }).strict(),
  // The name is one folder name and the parent an absolute path: the renderer
  // chooses where a project goes, never a path that climbs out of it.
  "projects.create": z.object({
    name: z
      .string()
      .min(1)
      .max(256)
      .refine((n) => projectNameProblem(n) === null, { error: (issue) => projectNameProblem(issue.input) ?? "Invalid project name" }),
    parentDir: z.string().min(1).max(4096).refine((p) => path.isAbsolute(p), "must be an absolute path").optional(),
  }).strict(),
  "projects.reorder": z.object({ order: z.array(z.string().min(1).max(4096)).max(100) }).strict(),
  "projects.rename": z.object({ workspace: z.string().min(1).max(4096), name: z.string().min(1).max(256) }).strict(),
  "projects.delete": z.object({ workspace: z.string().min(1).max(4096) }).strict(),
  "projects.addFolder": z.object({ workspace: z.string().min(1).max(4096), folder: z.string().min(1).max(4096) }).strict(),
  "projects.removeFolder": z.object({ workspace: z.string().min(1).max(4096), folder: z.string().min(1).max(4096) }).strict(),
  "projects.setAccessibleFolders": z.object({ workspace: z.string().min(1).max(4096), folders: z.array(z.string().min(1).max(4096)).max(50) }).strict(),
  "chat.rename": z.object({ workspace: z.string().min(1).max(4096), chatId: id, title: z.string().min(1).max(256) }).strict(),
  "chat.delete": z.object({ workspace: z.string().min(1).max(4096), chatId: id }).strict(),
  "chat.move": z.object({ fromWorkspace: z.string().min(1).max(4096), toWorkspace: z.string().min(1).max(4096), chatId: id }).strict(),
  "chat.reorder": z.object({ workspace: z.string().min(1).max(4096), order: z.array(id).max(200) }).strict(),
  "session.create": z.object({ workspace: z.string().min(1).max(4096), chatId: id.optional() }).strict(),
  "session.snapshot": sessionOnly,
  "session.send": z.object({ sessionId: id, prompt: z.string().min(1).max(200_000) }).strict(),
  "session.interrupt": sessionOnly,
  "session.newChat": sessionOnly,
  "session.openChat": z.object({ sessionId: id, chatId: id }).strict(),
  "session.listChats": sessionOnly,
  "session.turnLog": sessionOnly,
  "session.setWorkspace": z.object({ sessionId: id, workspace: z.string().min(1).max(4096), chatId: id.optional() }).strict(),
  "session.updateSettings": z
    .object({ sessionId: id, patch: z.record(z.string(), z.unknown()), persist: z.boolean().optional() })
    .strict(),
  "session.resolveApproval": z
    .object({ sessionId: id, approvalId: id, approved: z.boolean(), reason: z.string().max(500).optional() })
    .strict(),
  "session.exportMarkdown": z.object({ sessionId: id, filename: exportFilename.optional() }).strict(),
  "session.refreshQuotas": sessionOnly,
  "session.stop": sessionOnly,
  "quotas.refresh": z.object({}).strict(),
  "accounts.list": refreshOnly,
  "accounts.signIn": z.object({ provider: providerArg }).strict(),
  "accounts.signOut": z.object({ provider: providerArg }).strict(),
  "accounts.testEndpoint": z
    .object({ provider: z.enum(["ollama", "compat-api"]), baseUrl: z.string().max(2048).optional() })
    .strict(),
  "models.catalog": refreshOnly,
  "config.get": z.object({}).strict(),
  "config.update": z.object({ patch: z.record(z.string(), z.unknown()) }).strict(),
  "doctor.run": doctorOpts,
  "doctor.repair": z.object({ id: z.string().min(1).max(64), workspace: z.string().min(1).max(4096).optional() }).strict(),
  "doctor.report": doctorOpts,
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
    quotas: s.quotas.snapshotAll(),
  };
}

/**
 * @param {import("./session-manager.js").SessionManager} manager
 * @param {{ quotaOptions?: Partial<ConstructorParameters<typeof QuotaMonitor>[0]> }} [opts]
 *   quotaOptions: how the engine's own quota monitor reads usage (tests stub the probes)
 * @returns {(name: string, args?: unknown) => Promise<unknown>}
 */
export function createCommandRouter(manager, opts = {}) {
  /** @param {string} sessionId */
  const session = (sessionId) => {
    const s = manager.get(sessionId);
    if (!s) throw new Error(`No session '${sessionId}'.`);
    return s;
  };

  /**
   * The folders sessions have open. Doctor only touches a folder that is a
   * registered project or one of these.
   *
   * @returns {string[]}
   */
  const openWorkspaces = () => manager.list().map((s) => s.workspace);

  /**
   * The engine's own quota monitor, for when no session is open. It has no
   * lead client (so no lead probe) and never polls; it reads the saved
   * defaults and shares the quota cache with the sessions.
   *
   * @type {QuotaMonitor|null}
   */
  let engineQuotas = null;
  const sessionlessQuotas = () =>
    (engineQuotas ??= new QuotaMonitor({
      getClient: () => null,
      getSettings: () => snapshotSettings(loadConfig()),
      ...opts.quotaOptions,
    }));

  /** @type {Record<CommandName, (args: any) => unknown>} */
  const handlers = {
    "app.info": () => ({ version: VERSION, platform: process.platform }),
    "prefs.get": () => loadPrefs(),
    "prefs.set": ({ patch }) => savePrefs(patch),
    "projects.list": () => listProjects(),
    "projects.listChats": ({ workspace }) => listChats(workspace),
    "projects.create": ({ name, parentDir }) => createProject(name, parentDir),
    "projects.reorder": ({ order }) => reorderProjects(order),
    "projects.rename": ({ workspace, name }) => renameProject(workspace, name),
    "projects.delete": ({ workspace }) => removeProject(workspace),
    "projects.addFolder": ({ workspace, folder }) => addAccessibleFolder(workspace, folder),
    "projects.removeFolder": ({ workspace, folder }) => removeAccessibleFolder(workspace, folder),
    "projects.setAccessibleFolders": ({ workspace, folders }) => setAccessibleFolders(workspace, folders),
    "chat.rename": ({ workspace, chatId, title }) => renameChat(workspace, chatId, title),
    "chat.delete": ({ workspace, chatId }) => deleteChat(workspace, chatId),
    "chat.move": ({ fromWorkspace, toWorkspace, chatId }) => moveChat(fromWorkspace, toWorkspace, chatId),
    "chat.reorder": ({ workspace, order }) => reorderChats(workspace, order),
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
    "session.setWorkspace": async ({ sessionId, workspace, chatId }) => {
      await session(sessionId).setWorkspace(workspace, { chatId });
      return sessionSnapshot(session(sessionId));
    },
    "session.updateSettings": ({ sessionId, patch, persist }) =>
      session(sessionId).updateSettings(patch, { persist: Boolean(persist) }),
    "session.resolveApproval": ({ sessionId, approvalId, approved, reason }) =>
      session(sessionId).resolveApproval(approvalId, approved, reason),
    "session.exportMarkdown": ({ sessionId, filename }) =>
      session(sessionId).exportMarkdown(filename, { dir: loadPrefs().exportDir ?? undefined }),
    "session.refreshQuotas": ({ sessionId }) => session(sessionId).refreshQuotas(),
    "session.stop": async ({ sessionId }) => {
      await manager.close(sessionId);
      return null;
    },
    // An open session's monitor stays the one source (its cache writes and `quota.updated`); with none, the engine's reads the same accounts.
    // Callers that ask while a probe runs share it (the monitor's own dedupe).
    "quotas.refresh": () => {
      const open = manager.list().find((s) => !s.closed);
      return open ? open.refreshQuotas() : sessionlessQuotas().probeAll();
    },
    "accounts.list": ({ refresh }) => listAccounts({ refresh }),
    "accounts.signIn": ({ provider }) => signIn(provider),
    "accounts.signOut": ({ provider }) => signOut(provider),
    "accounts.testEndpoint": ({ provider, baseUrl }) => testEndpoint({ provider, baseUrl }),
    "models.catalog": ({ refresh }) => getCatalog({ refresh }),
    "config.get": () => globalConfig(),
    "config.update": ({ patch }) => updateGlobalConfig(patch),
    "doctor.run": ({ workspace }) => runDoctor({ workspace, openWorkspaces: openWorkspaces() }),
    "doctor.repair": ({ id: repairId, workspace }) => repairDoctor(repairId, { workspace, openWorkspaces: openWorkspaces() }),
    "doctor.report": ({ workspace }) => doctorReport({ workspace, openWorkspaces: openWorkspaces() }),
  };

  return async function run(name, args) {
    if (!Object.hasOwn(CommandSchemas, name)) throw new Error(`Unknown command '${name}'.`);
    const command = /** @type {CommandName} */ (name);
    const parsed = CommandSchemas[command].parse(args ?? {});
    return handlers[command](parsed);
  };
}
