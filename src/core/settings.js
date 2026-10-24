// @ts-check
/**
 * settings.js — The settings one session runs with.
 *
 * A session copies the global config (~/.kumo/config.json) when it starts
 * and from then on changes only through Session.updateSettings. Before, the
 * bridge re-read the global file on every worker call, so switching the
 * worker or the safety mode in one window changed a turn already running in
 * another.
 */

import { isDeepStrictEqual } from "node:util";
import { normalizeConfigValue } from "../config/settings.js";
import { emptyRoles } from "../config/roles.js";

/** @typedef {import("./events.js").SessionSettings} SessionSettings */

/** The config keys that belong to a session. */
export const SESSION_SETTING_KEYS = /** @type {const} */ ([
  "orchestratorProvider",
  "orchestratorModel",
  "reasoningEffort",
  "workerProvider",
  "workerModel",
  "workerEffort",
  "safetyMode",
  "timeoutMs",
  "turnTimeoutMs",
  // Per-role model assignments and custom roles. A patch replaces the whole
  // value; roles.js has helpers that build the next one.
  "roles",
]);

/**
 * Copy the session keys out of a loaded config.
 *
 * @param {Record<string, any>} config
 * @returns {SessionSettings}
 */
export function snapshotSettings(config) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of SESSION_SETTING_KEYS) out[key] = config[key];
  // A copy: a session's roles must not alias the config object it came from.
  out.roles = config.roles ? structuredClone(config.roles) : emptyRoles();
  return /** @type {SessionSettings} */ (out);
}

/**
 * Validate a partial update against the same rules the global config uses.
 * Unknown keys and invalid values throw; unchanged values are dropped.
 *
 * @param {SessionSettings} current
 * @param {Partial<Record<string, unknown>>} patch
 * @returns {{ next: SessionSettings, changed: string[] }}
 */
export function applySettingsPatch(current, patch) {
  const next = { ...current };
  /** @type {string[]} */
  const changed = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    if (!(/** @type {readonly string[]} */ (SESSION_SETTING_KEYS).includes(key))) {
      throw new Error(`'${key}' is not a session setting. Allowed: ${SESSION_SETTING_KEYS.join(", ")}`);
    }
    const value = normalizeConfigValue(key, raw);
    if (!isDeepStrictEqual(/** @type {Record<string, unknown>} */ (next)[key], value)) {
      /** @type {Record<string, unknown>} */ (next)[key] = value;
      changed.push(key);
    }
  }
  return { next, changed };
}
