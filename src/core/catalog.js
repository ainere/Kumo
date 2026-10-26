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
 * catalog.js — The models each provider offers, as Settings › Models shows them.
 *
 * One entry per provider. Where a provider can list its own models (Codex
 * `model/list`, `agy models`, a running Ollama) and is available now, the live
 * list is used; otherwise Kumo's catalog (src/config/models.js). A live list is
 * only asked for from a provider that is signed in: nothing here starts a
 * Codex app-server for a signed-out account.
 *
 * Context windows are reported only when a provider says so; none of the
 * lists above does, so they are null. Nothing is guessed.
 */

import { ALLOWED_PROVIDERS, MODEL_CATALOG, EFFORT_LEVELS, claudeEfforts, providerDisplayName, supportsEffort } from "../config/models.js";
import { workerCapabilities } from "../providers/workers/capabilities.js";
import { orchestratorDelegates } from "../providers/orchestrators/registry.js";
import { CodexAppClient } from "../providers/orchestrators/codex-client.js";
import { getAgyModels, DEFAULT_WORKER_MODELS } from "../bridge/agy-runner.js";
import { getOllamaModels } from "../utils/model-picker.js";
import { listAccounts } from "./accounts.js";

/**
 * Mirrors `CatalogModel` in the desktop renderer's types.ts.
 *
 * @typedef {Object} CatalogModel
 * @property {string} id
 * @property {string} name
 * @property {string | null} desc
 * @property {string | null} alias
 * @property {string[]} efforts - reasoning efforts the model takes; empty when it picks its own
 * @property {string | null} defaultEffort
 * @property {number | null} contextWindow
 * @property {string[] | null} inputModalities
 */

/**
 * @typedef {Object} CatalogProvider
 * @property {string} provider
 * @property {string} name
 * @property {"subscription" | "api" | "local"} kind
 * @property {boolean} available - installed, and not known to be signed out
 * @property {boolean | null} signedIn - null when the provider's CLI cannot say (Cursor Agent, OpenCode, CommandCode, a custom COPILOT_BIN)
 * @property {boolean} canWrite
 * @property {boolean} canLead
 * @property {"live" | "catalog"} source
 * @property {CatalogModel[]} models
 */

/** A provider's own list changes with releases and plans, not by the minute. */
const CATALOG_TTL_MS = 5 * 60 * 1000;
/** `codex app-server` has to start before it can answer. */
const CODEX_LIST_TIMEOUT_MS = 15_000;
const CODEX_MAX_PAGES = 5;

/**
 * The efforts the direct-API transports act on: `low` sends nothing,
 * `medium` and `high` set the request's reasoning effort, and `max` reads as
 * `high` (src/providers/api/api-transport.js).
 */
const API_EFFORTS = ["low", "medium", "high"];

/** The efforts agy has for a model it takes one for: its -low, -medium and -high variants. */
const AGY_EFFORTS = ["low", "medium", "high"];

/**
 * What a provider's `--effort` takes for a model, when the provider cannot
 * list them itself. Codex every level Kumo does (its live list says which,
 * per model); Claude Code what its model table gives the model
 * (claudeEfforts); Antigravity its three variants, only for the models
 * `supportsEffort` names (for its Claude models agy chooses itself);
 * text-only API workers the three levels their transport acts on; the rest
 * choose their own.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {string[]}
 */
function effortsFor(provider, model) {
  switch (provider) {
    case "codex":
      return [...EFFORT_LEVELS];
    case "claude":
      return claudeEfforts(model);
    case "antigravity":
      return supportsEffort(model) ? [...AGY_EFFORTS] : [];
    case "openai-api":
    case "anthropic-api":
    case "gemini-api":
      return [...API_EFFORTS];
    default:
      return [];
  }
}

/**
 * @param {string} provider
 * @param {string} id
 */
function catalogEntry(provider, id) {
  return (MODEL_CATALOG[provider] ?? []).find((m) => m.id === id);
}

/**
 * @param {string} provider
 * @param {{ id: string, name?: string, desc?: string, alias?: string }} entry
 * @returns {CatalogModel}
 */
function fromCatalog(provider, entry) {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    desc: entry.desc || null,
    alias: entry.alias || null,
    efforts: effortsFor(provider, entry.id),
    defaultEffort: null,
    contextWindow: null,
    inputModalities: null,
  };
}

/**
 * Race a promise against a deadline, so a hung CLI cannot hold the catalog.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, what) {
  /** @type {ReturnType<typeof setTimeout>} */
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The models this Codex account can run, with their efforts, from the
 * app-server's `model/list`. (`getOrchestratorModels` asks the same thing but
 * keeps only id, name and description.) Null when the server cannot say.
 *
 * @returns {Promise<CatalogModel[] | null>}
 */
async function listCodexModels() {
  const client = new CodexAppClient();
  try {
    const models = await withTimeout(
      (async () => {
        await client.start();
        /** @type {any[]} */
        const items = [];
        /** @type {string | null} */
        let cursor = null;
        for (let page = 0; page < CODEX_MAX_PAGES; page++) {
          const res = await client.request("model/list", cursor ? { cursor } : {});
          if (Array.isArray(res?.data)) items.push(...res.data);
          cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : null;
          if (!cursor) break;
        }
        return items;
      })(),
      CODEX_LIST_TIMEOUT_MS,
      "Codex model list"
    );
    /** @type {Map<string, CatalogModel>} */
    const out = new Map();
    for (const item of models) {
      if (typeof item?.id !== "string" || !item.id || item.hidden === true || out.has(item.id)) continue;
      const known = catalogEntry("codex", item.id);
      // Only the levels Kumo itself accepts (config validation rejects the rest).
      const efforts = (Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [])
        .map((/** @type {any} */ o) => o?.reasoningEffort)
        .filter((/** @type {unknown} */ level) => typeof level === "string" && EFFORT_LEVELS.includes(level));
      out.set(item.id, {
        id: item.id,
        name: item.displayName || item.id,
        desc: item.description || null,
        alias: known?.alias || null,
        efforts,
        defaultEffort: efforts.includes(item.defaultReasoningEffort) ? item.defaultReasoningEffort : null,
        contextWindow: null,
        inputModalities: Array.isArray(item.inputModalities) ? item.inputModalities.filter((/** @type {unknown} */ m) => typeof m === "string") : null,
      });
    }
    return out.size > 0 ? [...out.values()] : null;
  } catch {
    // The caller falls back to the catalog and says so with `source: "catalog"`.
    return null;
  } finally {
    await client.stop().catch(() => {});
  }
}

/**
 * Antigravity's own list, or null when `agy models` could not answer (the
 * runner then hands back its built-in list, which is the catalog anyway).
 *
 * @returns {Promise<CatalogModel[] | null>}
 */
async function listAntigravityModels() {
  const list = await getAgyModels();
  if (list === DEFAULT_WORKER_MODELS) return null;
  return list.map((m) => {
    const known = catalogEntry("antigravity", m.id);
    const entry = fromCatalog("antigravity", { id: m.id, name: m.name, desc: known?.desc, alias: known?.alias });
    // The variants agy listed are the efforts it has for this model (GPT-OSS: only medium).
    const listed = Array.isArray(m.efforts) ? m.efforts.filter((level) => AGY_EFFORTS.includes(level)) : [];
    return entry.efforts.length > 0 && listed.length > 0 ? { ...entry, efforts: listed } : entry;
  });
}

/**
 * The models pulled into the local Ollama. An empty list from a running
 * server is a real answer (nothing pulled yet).
 *
 * @returns {Promise<CatalogModel[]>}
 */
async function listOllamaModels() {
  const list = await getOllamaModels();
  return list.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    desc: null,
    alias: null,
    efforts: [],
    defaultEffort: null,
    contextWindow: null,
    inputModalities: null,
  }));
}

/** What the module asks providers; replaceable in tests so none is started. */
const defaultDeps = {
  codex: listCodexModels,
  antigravity: listAntigravityModels,
  ollama: listOllamaModels,
};
let deps = defaultDeps;

/**
 * Test seam: replace the live-list functions (and drop the cache). Call with
 * no argument to restore them.
 *
 * @param {Partial<typeof defaultDeps>} [overrides]
 */
export function setCatalogDeps(overrides = {}) {
  deps = { ...defaultDeps, ...overrides };
  clearCatalogCache();
}

/**
 * Whether a provider's models can be offered: it is installed and not known
 * to be signed out. A CLI that cannot report its login (`signedIn` null) is
 * offered anyway; the entry's `signedIn` says it could not be checked.
 *
 * @param {import("./accounts.js").AccountStatus} account
 */
function isAvailable(account) {
  return account.installed && account.signedIn !== false;
}

/**
 * @param {import("./accounts.js").AccountStatus} account
 * @returns {Promise<CatalogProvider>}
 */
async function buildProvider(account) {
  const provider = account.provider;
  const available = isAvailable(account);
  /** @type {CatalogProvider} */
  const entry = {
    provider,
    name: providerDisplayName(provider),
    kind: account.kind,
    available,
    signedIn: account.signedIn,
    canWrite: workerCapabilities(provider).canWrite,
    canLead: orchestratorDelegates(provider),
    source: "catalog",
    models: [],
  };

  // A live list only from a provider known to be up: asking a signed-out Codex
  // would start an app-server for nothing, and `ollama list` would start a server.
  // One that cannot be asked fails alone and shows the catalog's list instead.
  /** @type {CatalogModel[] | null} */
  let live = null;
  if (account.signedIn === true && Object.hasOwn(deps, provider)) {
    try {
      live = await deps[/** @type {keyof typeof deps} */ (provider)]();
    } catch {
      live = null;
    }
  }
  if (live) {
    entry.source = "live";
    entry.models = live;
  } else {
    entry.models = (MODEL_CATALOG[provider] ?? []).map((m) => fromCatalog(provider, m));
  }
  return entry;
}

/** @type {Map<string, { at: number, state: string, value: CatalogProvider }>} */
const entries = new Map();
/** @type {Map<string, { state: string, promise: Promise<CatalogProvider> }>} */
const building = new Map();

/** Test seam: forget every cached entry. */
export function clearCatalogCache() {
  entries.clear();
  building.clear();
}

/**
 * @param {import("./accounts.js").AccountStatus} account
 * @param {boolean} refresh
 * @returns {Promise<CatalogProvider>}
 */
function providerEntry(account, refresh) {
  const provider = account.provider;
  // A change in availability or sign-in (a sign-in, a sign-out, a CLI that now answers) invalidates the entry at once.
  const state = `${isAvailable(account)}/${account.signedIn}`;
  if (!refresh) {
    const hit = entries.get(provider);
    if (hit && hit.state === state && Date.now() - hit.at < CATALOG_TTL_MS) return Promise.resolve(hit.value);
    const pending = building.get(provider);
    if (pending && pending.state === state) return pending.promise;
  }
  const promise = buildProvider(account);
  const mine = { state, promise };
  building.set(provider, mine);
  promise
    .then((value) => {
      // Only the newest build's entry is kept (a cache clear or a newer build may have replaced this one).
      if (building.get(provider) === mine) entries.set(provider, { at: Date.now(), state, value });
    })
    .catch(() => {})
    .finally(() => {
      if (building.get(provider) === mine) building.delete(provider);
    });
  return promise;
}

/**
 * Every provider and the models it offers, in `ALLOWED_PROVIDERS` order.
 * Entries are kept for five minutes; `refresh` asks again (accounts too).
 *
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<CatalogProvider[]>}
 */
export async function getCatalog({ refresh = false } = {}) {
  const accounts = await listAccounts({ refresh });
  const byProvider = new Map(accounts.map((a) => [a.provider, a]));
  const list = await Promise.all(
    ALLOWED_PROVIDERS.map((provider) => {
      const account = byProvider.get(provider);
      if (!account) throw new Error(`No account status for '${provider}'.`);
      return providerEntry(account, refresh);
    })
  );
  // A copy: the cached entries stay as built, whatever a caller does with the result.
  return structuredClone(list);
}
