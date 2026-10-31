/**
 * opencode.js — OpenCode worker provider adapter.
 * Runs non-interactive worker tasks using `opencode run`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  grantsWrite,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "opencode",
  name: "OpenCode Worker",
};

/** Permissions a read-only worker is denied: `edit` covers write, patch and multiedit too, and `task` a subagent that might hold them. */
export const READ_ONLY_PERMISSIONS = { edit: "deny", bash: "deny", task: "deny" };

/**
 * @typedef {Record<string, string>} OpencodeRules tool name (or pattern) to `allow`, `ask` or `deny`; the last matching rule wins
 * @typedef {{
 *   mcp?: Record<string, unknown>,
 *   permission?: OpencodeRules,
 *   agent?: Record<string, { permission: OpencodeRules }>,
 * }} OpencodeConfigPatch
 */

export function findOpencodeBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  return resolveBinary("opencode");
}

/**
 * `rules` as a config patch, set globally and for `build`, the agent `run`
 * uses by default. An agent's own permissions beat the global ones, so without
 * the second a repository's opencode.json that allows bash for `build` would
 * lift a denial set only globally.
 *
 * @param {OpencodeRules} rules
 * @returns {OpencodeConfigPatch}
 */
export function opencodePermissionPatch(rules) {
  return { permission: rules, agent: { build: { permission: rules } } };
}

/** @param {unknown} value @returns {Record<string, any>} the object, or an empty one when it is not a plain object */
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});

/**
 * `rules` laid over `existing`. The last matching rule wins, so ours go last
 * and in their own order: an older entry left after one of ours (a user's
 * catch-all `*`, say) would otherwise beat it.
 *
 * @param {unknown} existing
 * @param {OpencodeRules} rules
 * @returns {Record<string, unknown>}
 */
function layerRules(existing, rules) {
  const kept = { ...asObject(existing) };
  for (const name of Object.keys(rules)) delete kept[name];
  return { ...kept, ...rules };
}

/**
 * The value of `OPENCODE_CONFIG_CONTENT`, opencode's inline config that is
 * layered over the user's own for one run, so nothing is written to disk.
 * Whatever the environment already sets there is kept: `mcp` servers are added
 * to it, and permission rules (global, and per agent) are laid over it.
 *
 * @param {OpencodeConfigPatch} patch
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function opencodeConfigContent(patch, env = process.env) {
  /** @type {Record<string, any>} */
  let base = {};
  try {
    base = asObject(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}"));
  } catch {
    /* not usable as a base; the run's own settings stand alone */
  }
  const merged = { ...base };
  if (patch.mcp) merged.mcp = { ...asObject(merged.mcp), ...patch.mcp };
  if (patch.permission) merged.permission = layerRules(merged.permission, patch.permission);
  if (patch.agent) {
    // The user's other agents, and the other settings of this one, are left as they are.
    const agents = { ...asObject(merged.agent) };
    for (const [name, { permission }] of Object.entries(patch.agent)) {
      const own = asObject(agents[name]);
      agents[name] = { ...own, permission: layerRules(own.permission, permission) };
    }
    merged.agent = agents;
  }
  return JSON.stringify(merged);
}

export async function executeTask(opts) {
  const {
    prompt,
    files = [],
    workspace = process.cwd(),
    model,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findOpencodeBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents: opts.fileContents });
  const write = grantsWrite(opts);

  // `run` takes the message as its positional argument and appends piped input
  // to it. The prompt spans lines and may be long, which a Windows .cmd shim
  // cannot carry in argv, so it goes over stdin with no positional message.
  const args = ["run"];
  if (model) {
    args.push("--model", model);
  }
  // Without `--auto` a non-interactive run rejects every permission request, so
  // only a task that may change files gets it. A read-only task is also denied
  // editing and shell commands outright, whatever the user's own config allows
  // (for the default agent too, which would otherwise beat a global denial).
  // That is `build`, so it is named: a repository's opencode.json can set another
  // `default_agent`, and the denials would not reach it.
  if (write) {
    args.push("--auto");
  } else {
    args.push("--agent", "build");
  }

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "OpenCode",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: compositePrompt,
    extraEnv: write ? {} : { OPENCODE_CONFIG_CONTENT: opencodeConfigContent(opencodePermissionPatch(READ_ONLY_PERMISSIONS)) },
  });
}
