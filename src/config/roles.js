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
 * roles.js — Who does what: the lead and the worker roles.
 *
 * The lead is the orchestrator (`orchestratorProvider`, `orchestratorModel`,
 * `reasoningEffort`). Each worker role is one bridge tool and may run on its
 * own model, picked from any subscription the user is logged in to:
 *
 *   roles: {
 *     builder: { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" },
 *     custom: [{ id: "docs", name: "Docs writer", description: "…", prompt: "…",
 *                access: "write", provider: "claude", model: "claude-haiku-5-5" }],
 *   }
 *
 * A role without an assignment runs on the shared worker (`workerProvider`,
 * `workerModel`, `workerEffort`), so a config written before roles existed
 * behaves exactly as it did. There are no fallbacks between roles and no
 * crews: switching a role's provider mid-task breaks prompt caching and
 * continuity (owner decision, 2026-10).
 */

import {
  ALLOWED_PROVIDERS,
  EFFORT_LEVELS,
  MODEL_ID_PATTERN,
  canonicalizeProvider,
  detectProviderForModel,
  modelBelongsElsewhere,
  modelDisplayName,
  providerDisplayName,
} from "./models.js";
import { workerCapabilities } from "../providers/workers/capabilities.js";

/** @typedef {"read"|"write"} RoleAccess */
/** @typedef {"scout"|"builder"|"tester"|"researcher"|"reviewer"|"designer"} BuiltinRoleId */
/** @typedef {{ provider: string, model: string, effort?: string }} RoleAssignment */
/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   prompt: string,
 *   access: RoleAccess,
 *   provider?: string,
 *   model?: string,
 *   effort?: string,
 * }} CustomRole
 */
/** @typedef {{ [K in BuiltinRoleId]?: RoleAssignment } & { custom: CustomRole[] }} Roles */
/**
 * A role as the bridge and the CLI see it, built-in or custom.
 *
 * @typedef {{
 *   id: string,
 *   tool: string,
 *   access: RoleAccess,
 *   title: string,
 *   summary: string,
 *   custom: CustomRole | null,
 * }} RoleInfo
 */

/** @type {ReadonlyArray<{ id: BuiltinRoleId, tool: string, access: RoleAccess, title: string, summary: string }>} */
export const BUILTIN_ROLES = [
  {
    id: "scout",
    tool: "worker_explore",
    access: "read",
    title: "Scout",
    summary: "Read-only codebase exploration: locates files, symbols, call paths, dependencies and tests.",
  },
  {
    id: "builder",
    tool: "worker_implement",
    access: "write",
    title: "Builder",
    summary: "Implements a bounded coding task with clear acceptance criteria. Modifies and creates workspace files.",
  },
  {
    id: "tester",
    tool: "worker_test",
    access: "write",
    title: "Tester",
    summary: "Writes and runs tests with the project's own commands and reports the exact results.",
  },
  {
    id: "researcher",
    tool: "worker_research",
    access: "read",
    title: "Researcher",
    summary: "Technical research: documentation, API specifications and version-specific behavior.",
  },
  {
    id: "reviewer",
    tool: "worker_review",
    access: "read",
    title: "Reviewer",
    summary: "Independent code review for correctness, security and regression risks.",
  },
  {
    id: "designer",
    tool: "worker_design",
    access: "write",
    title: "Designer",
    summary:
      "Owns the visual and interaction design and implements it: UI/UX, layout, typography, motion and the design-facing code.",
  },
];

/** @type {BuiltinRoleId[]} */
export const BUILTIN_ROLE_IDS = BUILTIN_ROLES.map((r) => r.id);

const BUILTIN_BY_ID = new Map(BUILTIN_ROLES.map((r) => [r.id, r]));
const BUILTIN_BY_TOOL = new Map(BUILTIN_ROLES.map((r) => [r.tool, r]));

/**
 * Custom role ids: lowercase, 2–31 characters, exposed as `worker_<id>`. No
 * trailing '-': MCP clients warn about tool names that end in one.
 */
export const CUSTOM_ROLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/;

/**
 * Ids a custom role cannot take: the built-in roles, words the CLI gives a
 * meaning (`lead`, `default`), and the suffixes of the built-in tools — a
 * custom `explore` would register a second `worker_explore`.
 */
export const RESERVED_ROLE_IDS = new Set([
  ...BUILTIN_ROLE_IDS,
  ...BUILTIN_ROLES.map((r) => r.tool.slice("worker_".length)),
  "lead",
  "orchestrator",
  "worker",
  "custom",
  "default",
  "task",
]);

export const MAX_CUSTOM_ROLES = 16;
const MAX_NAME_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 400;
export const MAX_ROLE_PROMPT_CHARS = 16000;

/** @returns {Roles} every role on the shared worker */
export function emptyRoles() {
  return { custom: [] };
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isPlainObject(v) {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {readonly string[]} allowed
 * @param {string} where
 */
function rejectUnknownKeys(obj, allowed, where) {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw new Error(`${where}: unknown key${extra.length > 1 ? "s" : ""} ${extra.join(", ")}. Allowed: ${allowed.join(", ")}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {{ max: number, required?: boolean, multiline?: boolean }} rules
 * @returns {string}
 */
function text(value, where, { max, required = false, multiline = false }) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new Error(`${where} must be a string`);
  const raw = typeof value === "string" ? value.trim() : "";
  const clean = multiline ? raw.replace(/\r\n/g, "\n") : raw.replace(/\s+/g, " ");
  if (required && !clean) throw new Error(`${where} must not be empty`);
  if (clean.length > max) throw new Error(`${where} is longer than ${max} characters`);
  if (clean.includes("\0")) throw new Error(`${where} must not contain NUL characters`);
  return clean;
}

/**
 * Validate one role's model assignment.
 *
 * @param {unknown} raw
 * @param {string} where - e.g. "roles.builder", for messages
 * @param {RoleAccess} access
 * @returns {RoleAssignment}
 */
function normalizeAssignment(raw, where, access) {
  if (!isPlainObject(raw)) throw new Error(`${where} must be an object with a model, and optionally a provider and effort`);
  rejectUnknownKeys(raw, ["provider", "model", "effort"], where);
  const model = String(raw.model ?? "").trim();
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new Error(`${where}.model must be 1-120 chars of letters, digits, '.', '_' or '-'`);
  }
  const provider =
    raw.provider === undefined || raw.provider === null || raw.provider === ""
      ? detectProviderForModel(model)
      : canonicalizeProvider(raw.provider);
  if (!ALLOWED_PROVIDERS.includes(provider)) {
    throw new Error(`${where}.provider must be one of: ${ALLOWED_PROVIDERS.join(", ")}`);
  }
  const elsewhere = modelBelongsElsewhere(provider, model);
  if (elsewhere) {
    throw new Error(`${where}: ${providerDisplayName(provider)} does not offer ${model}; use provider ${elsewhere}.`);
  }
  if (access === "write" && !workerCapabilities(provider).canWrite) {
    throw new Error(
      `${where}: ${provider} is a text-only worker and cannot modify files, but this role writes. ` +
        `Pick a CLI worker (claude, codex, antigravity, …).`
    );
  }
  /** @type {RoleAssignment} */
  const out = { provider, model };
  if (raw.effort !== undefined && raw.effort !== null && raw.effort !== "") {
    const effort = String(raw.effort).toLowerCase().trim();
    if (!EFFORT_LEVELS.includes(effort)) throw new Error(`${where}.effort must be one of: ${EFFORT_LEVELS.join(", ")}`);
    out.effort = effort;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @param {Set<string>} seen - ids already taken; the new id is added
 * @returns {CustomRole}
 */
function normalizeCustomRole(raw, index, seen) {
  let where = `roles.custom[${index}]`;
  if (!isPlainObject(raw)) throw new Error(`${where} must be an object`);
  rejectUnknownKeys(raw, ["id", "name", "description", "prompt", "access", "provider", "model", "effort"], where);
  const id = String(raw.id ?? "").trim();
  if (!CUSTOM_ROLE_ID_PATTERN.test(id)) {
    throw new Error(`${where}.id must match ${CUSTOM_ROLE_ID_PATTERN} (lowercase letters, digits and '-', 2-31 chars)`);
  }
  where = `role '${id}'`;
  if (RESERVED_ROLE_IDS.has(id)) throw new Error(`${where}: '${id}' is reserved; pick another id`);
  if (seen.has(id)) throw new Error(`${where} is defined twice`);

  const access = raw.access === undefined || raw.access === null || raw.access === "" ? "read" : String(raw.access).toLowerCase().trim();
  if (access !== "read" && access !== "write") throw new Error(`${where}.access must be read or write`);

  /** @type {CustomRole} */
  const role = {
    id,
    name: text(raw.name, `${where}.name`, { max: MAX_NAME_CHARS }) || id,
    description: text(raw.description, `${where}.description`, { max: MAX_DESCRIPTION_CHARS }),
    prompt: text(raw.prompt, `${where}.prompt`, { max: MAX_ROLE_PROMPT_CHARS, required: true, multiline: true }),
    access,
  };
  const hasModel = raw.model !== undefined && raw.model !== null && raw.model !== "";
  if (hasModel) {
    Object.assign(role, normalizeAssignment({ provider: raw.provider, model: raw.model, effort: raw.effort }, where, access));
  } else if ((raw.provider ?? "") !== "" || (raw.effort ?? "") !== "") {
    // An assignment is all or nothing: half of one would mix this role's
    // choice with whatever the shared worker happens to be.
    throw new Error(`${where}: a provider or effort needs a model too`);
  }
  seen.add(id);
  return role;
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function parseRolesValue(value) {
  let raw = value;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return {};
    try {
      raw = JSON.parse(t);
    } catch {
      throw new Error("Value for 'roles' must be a JSON object");
    }
  }
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw new Error("Value for 'roles' must be an object");
  return raw;
}

/**
 * Validate and normalize the whole `roles` value (an object, or its JSON
 * text from `kumo config set`). Throws with a message naming the problem.
 *
 * @param {unknown} value
 * @returns {Roles}
 */
export function normalizeRoles(value) {
  const raw = parseRolesValue(value);
  rejectUnknownKeys(raw, [...BUILTIN_ROLE_IDS, "custom"], "roles");
  /** @type {Record<string, any>} */
  const out = {};
  for (const role of BUILTIN_ROLES) {
    const entry = raw[role.id];
    if (entry === undefined || entry === null) continue;
    out[role.id] = normalizeAssignment(entry, `roles.${role.id}`, role.access);
  }
  const list = raw.custom === undefined || raw.custom === null ? [] : raw.custom;
  if (!Array.isArray(list)) throw new Error("roles.custom must be a list");
  if (list.length > MAX_CUSTOM_ROLES) throw new Error(`At most ${MAX_CUSTOM_ROLES} custom roles are allowed`);
  const seen = new Set();
  out.custom = list.map((entry, i) => normalizeCustomRole(entry, i, seen));
  return /** @type {Roles} */ (out);
}

/**
 * Normalize roles read from disk without failing: a hand-edited entry that
 * does not validate is left out and reported, and the rest still apply.
 *
 * @param {unknown} value
 * @returns {{ roles: Roles, problems: string[] }}
 */
export function sanitizeRoles(value) {
  try {
    return { roles: normalizeRoles(value), problems: [] };
  } catch {
    // Fall through: keep what is valid.
  }
  /** @type {string[]} */
  const problems = [];
  if (!isPlainObject(value)) return { roles: emptyRoles(), problems: ["'roles' is not an object"] };
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(value)) {
    if (key !== "custom" && !BUILTIN_BY_ID.has(/** @type {BuiltinRoleId} */ (key))) problems.push(`unknown role '${key}'`);
  }
  for (const role of BUILTIN_ROLES) {
    if (value[role.id] === undefined || value[role.id] === null) continue;
    try {
      out[role.id] = normalizeAssignment(value[role.id], `roles.${role.id}`, role.access);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  const seen = new Set();
  /** @type {CustomRole[]} */
  const custom = [];
  const list = Array.isArray(value.custom) ? value.custom : [];
  if (value.custom !== undefined && value.custom !== null && !Array.isArray(value.custom)) problems.push("roles.custom is not a list");
  for (const [i, entry] of list.entries()) {
    if (custom.length >= MAX_CUSTOM_ROLES) {
      problems.push(`more than ${MAX_CUSTOM_ROLES} custom roles; the rest are ignored`);
      break;
    }
    try {
      custom.push(normalizeCustomRole(entry, i, seen));
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  out.custom = custom;
  return { roles: /** @type {Roles} */ (out), problems };
}

/**
 * @param {{ roles?: Roles }} config
 * @returns {CustomRole[]}
 */
export function customRoles(config) {
  return Array.isArray(config?.roles?.custom) ? config.roles.custom : [];
}

/**
 * The tool a role is exposed as.
 *
 * @param {string} id
 * @returns {string}
 */
export function toolForRole(id) {
  const builtin = BUILTIN_BY_ID.get(/** @type {BuiltinRoleId} */ (id));
  return builtin ? builtin.tool : `worker_${id}`;
}

/**
 * A role by id, built-in or custom, or null.
 *
 * @param {{ roles?: Roles }} config
 * @param {string} id
 * @returns {RoleInfo|null}
 */
export function findRole(config, id) {
  const builtin = BUILTIN_BY_ID.get(/** @type {BuiltinRoleId} */ (id));
  if (builtin) return { ...builtin, custom: null };
  const custom = customRoles(config).find((c) => c.id === id);
  if (!custom) return null;
  return {
    id: custom.id,
    tool: toolForRole(custom.id),
    access: custom.access,
    title: custom.name,
    summary: custom.description,
    custom,
  };
}

/**
 * Every role, built-in first, then custom ones in the order they were added.
 *
 * @param {{ roles?: Roles }} config
 * @returns {RoleInfo[]}
 */
export function listRoles(config) {
  return [
    ...BUILTIN_ROLES.map((r) => ({ ...r, custom: null })),
    .../** @type {RoleInfo[]} */ (customRoles(config).map((c) => findRole(config, c.id)).filter(Boolean)),
  ];
}

/**
 * The role a tool call belongs to. Accepts the bare tool name and the
 * prefixed spellings orchestrators report (`mcp__kumo-bridge__worker_test`).
 *
 * @param {string} toolName
 * @param {Roles|undefined} roles
 * @returns {string|null}
 */
export function roleForTool(toolName, roles) {
  const match = /(?:^|[_./])(worker_[a-z][a-z0-9-]*)$/.exec(String(toolName || ""));
  if (!match) return null;
  const tool = match[1];
  const builtin = BUILTIN_BY_TOOL.get(tool);
  if (builtin) return builtin.id;
  const custom = (roles?.custom || []).find((c) => toolForRole(c.id) === tool);
  return custom ? custom.id : null;
}

/**
 * A role's own assignment, or null when it runs on the shared worker.
 *
 * @param {{ roles?: Roles }} config
 * @param {string} id
 * @returns {RoleAssignment|null}
 */
export function roleAssignment(config, id) {
  const builtin = BUILTIN_BY_ID.get(/** @type {BuiltinRoleId} */ (id));
  const entry = builtin ? config?.roles?.[builtin.id] : customRoles(config).find((c) => c.id === id);
  if (!entry || !entry.model) return null;
  /** @type {RoleAssignment} */
  const out = { provider: entry.provider || detectProviderForModel(entry.model), model: entry.model };
  if (entry.effort) out.effort = entry.effort;
  return out;
}

/**
 * The shared worker: what every role without an assignment runs on.
 *
 * @param {Record<string, any>} config
 * @returns {{ provider: string, model: string|undefined, effort: string|undefined }}
 */
export function sharedWorker(config) {
  return {
    provider: canonicalizeProvider(config.workerProvider || detectProviderForModel(config.workerModel)),
    model: config.workerModel || undefined,
    effort: config.workerEffort || undefined,
  };
}

/**
 * Which worker runs one call of a role, and with which model and effort.
 *
 * The role's assignment wins over the shared worker; the call's own
 * provider/model/effort win over both. A model and effort configured for one
 * provider are not handed to a per-call override of another — that CLI would
 * reject the id.
 *
 * @param {Record<string, any>} config - the effective settings
 * @param {string|null} roleId - null for a call that belongs to no role
 * @param {{ provider?: string, model?: string, effort?: string }} [call]
 * @param {{ provider: string, model?: string, effort?: string }} [worker] - the shared worker, after any overrides
 * @returns {{ provider: string, requested: string|null, model: string|undefined, effort: string|undefined, assigned: boolean }}
 */
export function resolveRoleTarget(config, roleId, call = {}, worker = sharedWorker(config)) {
  const own = roleId ? roleAssignment(config, roleId) : null;
  const configured = own
    ? { provider: own.provider, model: own.model, effort: own.effort || worker.effort }
    : worker;
  const requested = call.provider || null;
  const provider = requested || configured.provider;
  const onConfigured = !requested || canonicalizeProvider(requested) === canonicalizeProvider(configured.provider);
  return {
    provider,
    requested,
    model: call.model || (onConfigured ? configured.model : undefined) || undefined,
    effort: call.effort || (onConfigured ? configured.effort : undefined) || undefined,
    assigned: Boolean(own),
  };
}

/**
 * What changes the bridge's tool list: which custom roles exist and whether
 * each reads or writes (write tools take `confirm` and `previewId`). A model
 * change does not — the bridge resolves models on every call.
 *
 * @param {Roles|undefined} roles
 * @returns {string}
 */
export function roleToolSignature(roles) {
  return (roles?.custom || [])
    .map((c) => `${c.id}:${c.access}`)
    .sort()
    .join(",");
}

/**
 * "Claude Sonnet 5.5 (Claude Code), medium effort".
 *
 * @param {{ provider: string, model?: string, effort?: string }} target
 * @returns {string}
 */
export function describeTarget(target) {
  const model = target.model ? modelDisplayName(target.model, target.provider) : "its default model";
  const effort = target.effort ? `, ${target.effort} effort` : "";
  return `${model} (${providerDisplayName(target.provider)})${effort}`;
}

// ── edits that return a new roles value (validated by normalizeRoles) ──

/**
 * @param {Roles|undefined} roles
 * @returns {Roles}
 */
function copyRoles(roles) {
  return roles ? structuredClone(roles) : emptyRoles();
}

/**
 * Assign a model to a role, or clear the assignment with null so the role
 * follows the shared worker again.
 *
 * @param {Roles|undefined} roles
 * @param {string} id
 * @param {RoleAssignment|null} assignment
 * @returns {Roles}
 */
export function withRoleAssignment(roles, id, assignment) {
  const next = copyRoles(roles);
  if (BUILTIN_BY_ID.has(/** @type {BuiltinRoleId} */ (id))) {
    const key = /** @type {BuiltinRoleId} */ (id);
    if (assignment) next[key] = { ...assignment };
    else delete next[key];
    return next;
  }
  const custom = next.custom.find((c) => c.id === id);
  if (!custom) throw new Error(`Unknown role '${id}'. Roles: ${[...BUILTIN_ROLE_IDS, ...next.custom.map((c) => c.id)].join(", ")}`);
  delete custom.provider;
  delete custom.model;
  delete custom.effort;
  if (assignment) Object.assign(custom, assignment);
  return next;
}

/**
 * @param {Roles|undefined} roles
 * @param {Partial<CustomRole> & { id: string }} role
 * @returns {Roles}
 */
export function withCustomRole(roles, role) {
  const next = copyRoles(roles);
  if (next.custom.some((c) => c.id === role.id)) throw new Error(`A role '${role.id}' already exists.`);
  next.custom.push(/** @type {CustomRole} */ ({ ...role }));
  return next;
}

/**
 * @param {Roles|undefined} roles
 * @param {string} id
 * @returns {Roles}
 */
export function withoutCustomRole(roles, id) {
  const next = copyRoles(roles);
  if (BUILTIN_BY_ID.has(/** @type {BuiltinRoleId} */ (id))) {
    throw new Error(`'${id}' is a built-in role and cannot be removed; 'kumo role set ${id} default' puts it back on the shared worker.`);
  }
  const before = next.custom.length;
  next.custom = next.custom.filter((c) => c.id !== id);
  if (next.custom.length === before) throw new Error(`No custom role '${id}'.`);
  return next;
}
