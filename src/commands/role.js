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

/**
 * role.js — `kumo role`: which model runs the lead and each worker role.
 *
 *   kumo role list
 *   kumo role set <role> <model> [effort] [provider]
 *   kumo role add <id> --access read|write --prompt-file <file> [--model <m>] …
 *   kumo role remove <id>
 *
 * `set lead …` changes the orchestrator; `set <role> default` puts a role
 * back on the shared worker. The REPL's /role uses the same patch builders,
 * so both validate a change the same way (src/config/roles.js).
 */

import fs from "node:fs";
import path from "node:path";
import {
  loadConfig,
  setConfigValue,
  resolveModel,
  providerForModel,
  canonicalizeProvider,
  ALLOWED_PROVIDERS,
} from "../config/settings.js";
import { EFFORT_LEVELS, modelBelongsElsewhere } from "../config/models.js";
import {
  findRole,
  listRoles,
  roleAssignment,
  resolveRoleTarget,
  describeTarget,
  withRoleAssignment,
  withCustomRole,
  withoutCustomRole,
  MAX_ROLE_PROMPT_CHARS,
} from "../config/roles.js";
import { KNOWN_ORCHESTRATORS, orchestratorDelegates } from "../providers/orchestrators/registry.js";
import { c, badge, separator } from "../utils/ui.js";

/** Model arguments that clear a role's assignment. */
const CLEAR_WORDS = ["default", "worker", "shared"];

/** Providers that can lead: they call Kumo's worker tools. */
export function leadProviders() {
  return KNOWN_ORCHESTRATORS.filter((id) => ALLOWED_PROVIDERS.includes(id) && orchestratorDelegates(id));
}

/**
 * @param {string|undefined} effort
 * @returns {string|undefined}
 */
function checkEffort(effort) {
  if (effort === undefined || effort === null || effort === "") return undefined;
  const norm = String(effort).toLowerCase().trim();
  if (!EFFORT_LEVELS.includes(norm)) throw new Error(`Invalid effort '${effort}'. Allowed: ${EFFORT_LEVELS.join(", ")}`);
  return norm;
}

/**
 * The settings change `role set` makes, without applying it.
 *
 * @param {Record<string, any>} settings - the current settings (saved config or a session's)
 * @param {string} roleId - `lead`, a built-in role or a custom role's id
 * @param {string} rawModel - a model id or alias; `default` clears the role's assignment
 * @param {string} [effort]
 * @param {string} [provider] - otherwise kept when it offers the model, else the model's own
 * @returns {Record<string, any>} a patch of orchestrator keys, or `{ roles }`
 */
export function roleSetPatch(settings, roleId, rawModel, effort, provider) {
  const id = String(roleId || "").toLowerCase().trim();
  const level = checkEffort(effort);
  if (!rawModel) throw new Error("Usage: role set <role> <model> [effort] [provider]");
  const clearing = CLEAR_WORDS.includes(String(rawModel).toLowerCase().trim());

  if (id === "lead" || id === "orchestrator") {
    if (clearing) throw new Error("The lead always has its own model: role set lead <model> [effort] [provider]");
    const model = resolveModel(rawModel);
    const prov = provider ? canonicalizeProvider(provider) : providerForModel(model, settings.orchestratorProvider);
    if (!orchestratorDelegates(prov)) {
      throw new Error(`${prov} cannot call Kumo's worker tools, so it cannot lead. Leads: ${leadProviders().join(", ")}.`);
    }
    const elsewhere = modelBelongsElsewhere(prov, model);
    if (elsewhere) throw new Error(`${prov} does not offer ${model}; use provider ${elsewhere}.`);
    return { orchestratorProvider: prov, orchestratorModel: model, ...(level ? { reasoningEffort: level } : {}) };
  }

  const role = findRole(settings, id);
  if (!role) {
    throw new Error(`Unknown role '${roleId}'. Roles: lead, ${listRoles(settings).map((r) => r.id).join(", ")}`);
  }
  if (clearing) return { roles: withRoleAssignment(settings.roles, id, null) };

  const model = resolveModel(rawModel);
  const current = roleAssignment(settings, id);
  const prov = provider
    ? canonicalizeProvider(provider)
    : providerForModel(model, current?.provider || settings.workerProvider);
  // Keep the role's effort across a model switch on the same provider.
  const keep = level || (current && current.provider === prov ? current.effort : undefined);
  return { roles: withRoleAssignment(settings.roles, id, { provider: prov, model, ...(keep ? { effort: keep } : {}) }) };
}

/**
 * The settings change `role add` makes, without applying it.
 *
 * @param {Record<string, any>} settings
 * @param {string} id
 * @param {{ prompt: string, access?: string, name?: string, description?: string, model?: string, effort?: string, provider?: string }} opts
 * @returns {{ roles: any }}
 */
export function roleAddPatch(settings, id, opts) {
  /** @type {Record<string, any>} */
  const role = {
    id: String(id || "").trim(),
    name: opts.name,
    description: opts.description,
    prompt: opts.prompt,
    access: opts.access || "read",
  };
  if (opts.model) {
    role.model = resolveModel(opts.model);
    role.provider = opts.provider ? canonicalizeProvider(opts.provider) : providerForModel(role.model, settings.workerProvider);
    const level = checkEffort(opts.effort);
    if (level) role.effort = level;
  } else if (opts.effort || opts.provider) {
    throw new Error("--effort and --provider need --model too.");
  }
  return { roles: withCustomRole(settings.roles, /** @type {any} */ (role)) };
}

/**
 * @param {Record<string, any>} settings
 * @param {string} id
 * @returns {{ roles: any }}
 */
export function roleRemovePatch(settings, id) {
  return { roles: withoutCustomRole(settings.roles, String(id || "").trim()) };
}

/**
 * The lines `role list` and the REPL's /role print.
 *
 * @param {Record<string, any>} settings
 * @returns {string[]}
 */
export function formatRoles(settings) {
  const lines = [];
  const lead = {
    provider: settings.orchestratorProvider,
    model: settings.orchestratorModel,
    effort: settings.reasoningEffort,
  };
  lines.push(`  ${c.bold}${"lead".padEnd(12)}${c.reset}${c.gray}${"orchestrator".padEnd(18)}${"".padEnd(7)}${c.reset}${c.brightCyan}${describeTarget(lead)}${c.reset}`);
  let customHeader = false;
  for (const role of listRoles(settings)) {
    if (role.custom && !customHeader) {
      customHeader = true;
      lines.push(`  ${c.dim}custom roles${c.reset}`);
    }
    const target = resolveRoleTarget(settings, role.id);
    const shared = target.assigned ? "" : ` ${c.dim}· shared worker${c.reset}`;
    const about = role.custom ? ` ${c.dim}— ${role.title}${role.summary ? `: ${role.summary}` : ""}${c.reset}` : "";
    lines.push(
      `  ${c.bold}${role.id.padEnd(12)}${c.reset}${c.gray}${role.tool.padEnd(18)}${role.access.padEnd(7)}${c.reset}` +
        `${c.brightBlue}${describeTarget(target)}${c.reset}${shared}${about}`
    );
  }
  return lines;
}

function printRoles(config) {
  console.log(`\n${c.bold}${c.brightCyan}KUMO Roles${c.reset}`);
  console.log(separator(60));
  for (const line of formatRoles(config)) console.log(line);
  console.log(`\n  ${c.gray}kumo role set <role> <model> [effort] [provider]${c.reset}   assign a model ('default' clears it)`);
  console.log(`  ${c.gray}kumo role add <id> --access read|write --prompt-file <file> [--model <m>]${c.reset}`);
  console.log(`  ${c.gray}kumo role remove <id>${c.reset}\n`);
}

/** Save a patch to the global config, key by key, each validated on the way. */
function savePatch(patch) {
  for (const [key, value] of Object.entries(patch)) setConfigValue(key, value);
}

export function roleListCommand() {
  printRoles(loadConfig());
}

/**
 * @param {string} roleId
 * @param {string} model
 * @param {string} [effort]
 * @param {string} [provider]
 */
export function roleSetCommand(roleId, model, effort, provider) {
  const patch = roleSetPatch(loadConfig(), roleId, model, effort, provider);
  savePatch(patch);
  const config = loadConfig();
  const id = String(roleId).toLowerCase();
  if (id === "lead" || id === "orchestrator") {
    const lead = { provider: config.orchestratorProvider, model: config.orchestratorModel, effort: config.reasoningEffort };
    console.log(`${badge.ok} The lead runs on ${describeTarget(lead)}`);
  } else {
    const target = resolveRoleTarget(config, id);
    console.log(`${badge.ok} ${id} runs on ${describeTarget(target)}${target.assigned ? "" : " (the shared worker)"}`);
  }
}

/**
 * @param {string} id
 * @param {{ promptFile: string, access?: string, name?: string, description?: string, model?: string, effort?: string, provider?: string }} opts
 */
export function roleAddCommand(id, opts) {
  const file = path.resolve(opts.promptFile);
  let prompt;
  try {
    const stat = fs.statSync(file);
    // A generous byte cap before reading; the role's own limit is in characters.
    if (stat.size > MAX_ROLE_PROMPT_CHARS * 4) throw new Error(`is larger than ${MAX_ROLE_PROMPT_CHARS} characters`);
    prompt = fs.readFileSync(file, "utf-8");
  } catch (err) {
    throw new Error(`Could not read the prompt file ${file}: ${err.message}`);
  }
  savePatch(roleAddPatch(loadConfig(), id, { ...opts, prompt }));
  const config = loadConfig();
  const role = findRole(config, id);
  const target = resolveRoleTarget(config, id);
  console.log(
    `${badge.ok} Added the ${role.access} role '${id}' as ${role.tool}, on ${describeTarget(target)}${target.assigned ? "" : " (the shared worker)"}`
  );
  console.log(`  ${c.dim}Running sessions pick it up when their orchestrator restarts.${c.reset}`);
}

/** @param {string} id */
export function roleRemoveCommand(id) {
  savePatch(roleRemovePatch(loadConfig(), id));
  console.log(`${badge.ok} Removed the role '${id}'.`);
}
