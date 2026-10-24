import "./helpers/env.js";
/**
 * roles.test.js — The lead and the worker roles: validation, per-role
 * routing, the tools the bridge registers for them, their prompts, presets,
 * and `kumo role`.
 *
 * The bridge tests run a real bridge over stdio with a stub worker CLI that
 * records its argv, so "builder ran on Sonnet" is read off the command line
 * the worker was actually launched with.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeFixture } from "./helpers/bridge-fixture.js";
import { TEST_KUMO_HOME } from "./helpers/env.js";
import {
  normalizeRoles,
  roleForTool,
  roleToolSignature,
  withCustomRole,
  withRoleAssignment,
} from "../src/config/roles.js";
import {
  loadConfig,
  saveConfig,
  applyPreset,
  presetConfig,
  presetMatches,
  PRESETS,
} from "../src/config/settings.js";
import { configFile } from "../src/config/paths.js";
import { resolveWorkerTarget } from "../src/bridge/server.js";
import { getSystemPrompt } from "../src/bridge/prompts.js";
import { roleSetCommand, roleAddCommand, roleRemoveCommand, roleSetPatch } from "../src/commands/role.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../src/bridge/server.js");
const cliPath = path.resolve(__dirname, "../bin/kumo.js");

const SONNET = { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" };
const DOCS_ROLE = {
  id: "docs",
  name: "Docs writer",
  description: "Use for README and guide edits",
  prompt: "You keep the documentation accurate. Write in plain English.",
  access: "write",
};

/** A pre-roles config: the shared worker only. */
const WORKER_ONLY = { workerProvider: "antigravity", workerModel: "gemini-3.8-flash", workerEffort: "high" };

const textOf = (res) => (res?.content || []).map((c) => c.text || "").join("\n");
const modelOf = (call) => call.args[call.args.indexOf("--model") + 1];
const isClaude = (call) => call.args.includes("--strict-mcp-config");
const isCodex = (call) => call.args[0] === "exec";

/** Run `fn` with the saved config replaced, then put the old one back. */
function withSavedConfig(config, fn) {
  const file = configFile();
  const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
  try {
    if (config) saveConfig(config);
    return fn();
  } finally {
    if (saved === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, saved);
  }
}

// ── validation ──

test("a write role cannot run on a text-only worker; a read role can", () => {
  for (const role of ["builder", "tester", "designer"]) {
    assert.throws(
      () => normalizeRoles({ [role]: { provider: "ollama", model: "llama3.1" } }),
      /text-only worker and cannot modify files/,
      role
    );
  }
  assert.throws(
    () => normalizeRoles({ builder: { provider: "anthropic-api", model: "claude-sonnet-5-5" } }),
    /text-only/
  );
  assert.throws(
    () => normalizeRoles({ custom: [{ ...DOCS_ROLE, provider: "ollama", model: "llama3.1" }] }),
    /text-only/,
    "a custom write role is held to the same rule"
  );
  // Reading needs no write access: the bridge inlines files for these workers.
  assert.deepStrictEqual(normalizeRoles({ reviewer: { provider: "ollama", model: "llama3.1" } }).reviewer, {
    provider: "ollama",
    model: "llama3.1",
  });
  assert.strictEqual(normalizeRoles({ custom: [{ ...DOCS_ROLE, access: "read", provider: "ollama", model: "llama3.1" }] }).custom[0].provider, "ollama");
});

test("a role's model must be one its provider offers, by the catalog", () => {
  assert.throws(() => normalizeRoles({ scout: { provider: "codex", model: "claude-haiku-5-5" } }), /use provider claude/);
  // Without a provider, the model's own is taken.
  assert.strictEqual(normalizeRoles({ scout: { model: "claude-haiku-5-5" } }).scout.provider, "claude");
  // An id newer than the catalog is not refused.
  assert.strictEqual(normalizeRoles({ reviewer: { provider: "codex", model: "gpt-6.2-nova" } }).reviewer.model, "gpt-6.2-nova");
  assert.throws(() => normalizeRoles({ builder: { model: "x; rm -rf /" } }), /model must be/);
  assert.throws(() => normalizeRoles({ builder: { ...SONNET, effort: "turbo" } }), /effort must be one of/);
});

test("custom role ids are checked: pattern, reserved names, duplicates", () => {
  const custom = (id, extra = {}) => normalizeRoles({ custom: [{ ...DOCS_ROLE, id, ...extra }] });
  assert.strictEqual(custom("docs-2").custom[0].id, "docs-2");
  for (const bad of ["Docs", "d", "9docs", "docs_x", "docs-", "a".repeat(32)]) {
    assert.throws(() => custom(bad), /must match/, bad);
  }
  // Built-in role names, and the suffixes of built-in tools (worker_explore …).
  for (const reserved of ["builder", "scout", "explore", "implement", "design", "lead", "default"]) {
    assert.throws(() => custom(reserved), /reserved/, reserved);
  }
  assert.throws(() => normalizeRoles({ custom: [DOCS_ROLE, DOCS_ROLE] }), /defined twice/);
  assert.throws(() => custom("docs", { prompt: "   " }), /prompt must not be empty/);
  assert.throws(() => custom("docs", { access: "admin" }), /access must be read or write/);
  assert.throws(() => custom("docs", { effort: "low" }), /needs a model too/);
  assert.throws(() => normalizeRoles({ lead: SONNET }), /unknown key lead/);
});

test("roles can be set from JSON text, as `kumo config set roles` passes them", () => {
  const roles = normalizeRoles(JSON.stringify({ builder: SONNET }));
  assert.deepStrictEqual(roles, { builder: SONNET, custom: [] });
});

test("a hand-edited config with a bad role keeps its other roles and still loads", () => {
  withSavedConfig(null, () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({
        ...WORKER_ONLY,
        roles: {
          builder: SONNET,
          tester: { provider: "ollama", model: "llama3.1" },
          custom: [DOCS_ROLE, { id: "Bad Id", prompt: "x" }],
        },
      })
    );
    const config = loadConfig();
    assert.deepStrictEqual(config.roles.builder, SONNET);
    assert.strictEqual(config.roles.tester, undefined, "the invalid role is left out");
    assert.deepStrictEqual(config.roles.custom.map((c) => c.id), ["docs"]);
  });
});

// ── routing ──

test("a config without roles routes every role to the shared worker, as before roles existed", () => {
  for (const role of ["scout", "builder", "tester", "researcher", "reviewer", "designer"]) {
    const target = resolveWorkerTarget({ role }, WORKER_ONLY);
    assert.deepStrictEqual(
      { provider: target.provider, model: target.model, effort: target.effort, assigned: target.assigned },
      { provider: "antigravity", model: "gemini-3.8-flash", effort: "high", assigned: false },
      role
    );
  }
});

test("per-role routing: an assigned role runs on its own model, the others on the shared worker", () => {
  const config = {
    ...WORKER_ONLY,
    roles: normalizeRoles({
      builder: SONNET,
      scout: { provider: "claude", model: "claude-haiku-5-5" },
      custom: [{ ...DOCS_ROLE, provider: "codex", model: "gpt-6-luna", effort: "low" }],
    }),
  };
  const pick = (opts) => {
    const t = resolveWorkerTarget(opts, config);
    return [t.provider, t.model, t.effort];
  };
  assert.deepStrictEqual(pick({ role: "builder" }), ["claude", "claude-sonnet-5-5", "medium"]);
  // No effort of its own: the shared worker's effort.
  assert.deepStrictEqual(pick({ role: "scout" }), ["claude", "claude-haiku-5-5", "high"]);
  assert.deepStrictEqual(pick({ role: "tester" }), ["antigravity", "gemini-3.8-flash", "high"]);
  assert.deepStrictEqual(pick({ role: "docs" }), ["codex", "gpt-6-luna", "low"]);

  // Per-call arguments still win, and a role's model is not handed to another CLI.
  assert.deepStrictEqual(pick({ role: "builder", model: "claude-opus-5-5" }), ["claude", "claude-opus-5-5", "medium"]);
  assert.deepStrictEqual(pick({ role: "builder", provider: "codex" }), ["codex", undefined, undefined]);
  assert.deepStrictEqual(pick({ role: "builder", provider: "claude", effort: "max" }), ["claude", "claude-sonnet-5-5", "max"]);

  // KUMO_WORKER_PROVIDER overrides the shared worker, not a role's own choice.
  process.env.KUMO_WORKER_PROVIDER = "codex";
  try {
    assert.strictEqual(resolveWorkerTarget({ role: "builder" }, config).provider, "claude");
    assert.strictEqual(resolveWorkerTarget({ role: "tester" }, config).provider, "codex");
  } finally {
    delete process.env.KUMO_WORKER_PROVIDER;
  }
});

test("tool names map to their roles, prefixed or not", () => {
  const roles = normalizeRoles({ custom: [DOCS_ROLE] });
  assert.strictEqual(roleForTool("worker_explore", roles), "scout");
  assert.strictEqual(roleForTool("mcp__kumo-bridge__worker_implement", roles), "builder");
  assert.strictEqual(roleForTool("kumo-bridge.worker_design", roles), "designer");
  assert.strictEqual(roleForTool("worker_docs", roles), "docs");
  assert.strictEqual(roleForTool("worker_docs", { custom: [] }), null, "a removed custom role has no tool");
  assert.strictEqual(roleForTool("Read", roles), null);
});

test("only adding, removing or re-scoping a custom role changes the tool list", () => {
  const base = normalizeRoles({ custom: [DOCS_ROLE] });
  const sig = roleToolSignature(base);
  assert.strictEqual(roleToolSignature(withRoleAssignment(base, "builder", SONNET)), sig, "a model change keeps the tools");
  assert.strictEqual(roleToolSignature(withRoleAssignment(base, "docs", SONNET)), sig);
  assert.notStrictEqual(roleToolSignature(withCustomRole(base, { ...DOCS_ROLE, id: "ops" })), sig);
  assert.notStrictEqual(roleToolSignature({ custom: [{ ...DOCS_ROLE, access: "read" }] }), sig, "write tools have another schema");
});

// ── prompts ──

test("prompts name the role's model and the lead from the settings they are given, not the saved config", () => {
  withSavedConfig({ ...loadConfig(), orchestratorModel: "gpt-6-luna" }, () => {
    const config = { orchestratorModel: "claude-opus-5-5", reasoningEffort: "high", roles: normalizeRoles({ custom: [DOCS_ROLE] }) };
    const builder = getSystemPrompt("builder", { config, model: "claude-sonnet-5-5", effort: "medium" });
    assert.match(builder, /Builder worker \(running on claude-sonnet-5-5, reasoning effort: medium\)/);
    assert.match(builder, /lead orchestrator \(running on claude-opus-5-5, reasoning effort: high\)/);
    assert.doesNotMatch(builder, /gpt-6-luna/, "the saved config's lead is not this session's");

    assert.match(getSystemPrompt("designer", { config }), /own the visual and experiential outcome/);
    const docs = getSystemPrompt("docs", { config, model: "claude-haiku-5-5" });
    assert.match(docs, /"Docs writer" worker, a custom role/);
    assert.match(docs, /You keep the documentation accurate/);
    assert.match(docs, /may modify files/);
    // The old tool-kind names still resolve.
    assert.match(getSystemPrompt("explore", { config }), /repository exploration worker/);
  });
});

// ── presets ──

test("the claude preset fills the roles the design-build way and keeps custom roles", () => {
  const roles = PRESETS.claude.config.roles;
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(roles).map(([id, a]) => [id, a.model])),
    {
      designer: "claude-opus-5-5",
      reviewer: "claude-opus-5-5",
      builder: "claude-sonnet-5-5",
      tester: "claude-sonnet-5-5",
      scout: "claude-haiku-5-5",
      researcher: "claude-haiku-5-5",
    }
  );
  assert.strictEqual(PRESETS.claude.config.orchestratorModel, "claude-opus-5-5");
  // Every preset's roles pass the same validation as a user's.
  for (const name of Object.keys(PRESETS)) normalizeRoles(presetConfig(name, { custom: [] }).roles);

  withSavedConfig({ ...loadConfig(), roles: normalizeRoles({ custom: [DOCS_ROLE] }) }, () => {
    const applied = applyPreset("claude");
    assert.strictEqual(applied.roles.builder.model, "claude-sonnet-5-5");
    assert.deepStrictEqual(applied.roles.custom.map((c) => c.id), ["docs"], "custom roles survive a preset");
    assert.ok(presetMatches("claude", loadConfig()));
    // Another preset puts the built-in roles back on the shared worker.
    const back = applyPreset("default");
    assert.strictEqual(back.roles.builder, undefined);
    assert.deepStrictEqual(back.roles.custom.map((c) => c.id), ["docs"]);
    assert.ok(!presetMatches("claude", loadConfig()));
  });
});

// ── kumo role ──

test("kumo role set / add / remove change the saved roles, and refuse what cannot work", () => {
  withSavedConfig({ ...loadConfig(), ...WORKER_ONLY, roles: { custom: [] } }, () => {
    // Like /model: a provider that offers the model is kept (Antigravity has Sonnet).
    roleSetCommand("builder", "sonnet");
    assert.deepStrictEqual(loadConfig().roles.builder, { provider: "antigravity", model: "claude-sonnet-5-5" });
    roleSetCommand("builder", "sonnet", "high", "claude");
    assert.deepStrictEqual(loadConfig().roles.builder, { provider: "claude", model: "claude-sonnet-5-5", effort: "high" });

    // A model switch on the same provider keeps the role's effort.
    roleSetCommand("builder", "opus");
    assert.deepStrictEqual(loadConfig().roles.builder, { provider: "claude", model: "claude-opus-5-5", effort: "high" });

    roleSetCommand("builder", "default");
    assert.strictEqual(loadConfig().roles.builder, undefined, "'default' puts the role back on the shared worker");

    assert.throws(() => roleSetCommand("builder", "llama3.1", "low", "ollama"), /text-only/);
    assert.throws(() => roleSetCommand("nobody", "sonnet"), /Unknown role 'nobody'/);

    roleSetCommand("lead", "sonnet", "low");
    const lead = loadConfig();
    assert.deepStrictEqual([lead.orchestratorProvider, lead.orchestratorModel, lead.reasoningEffort], ["claude", "claude-sonnet-5-5", "low"]);
    assert.throws(() => roleSetCommand("lead", "llama3.1", "low", "ollama"), /cannot lead/);

    const promptFile = path.join(TEST_KUMO_HOME, "docs-prompt.md");
    fs.writeFileSync(promptFile, DOCS_ROLE.prompt);
    roleAddCommand("docs", { promptFile, access: "write", model: "haiku", name: "Docs writer" });
    assert.deepStrictEqual(
      (({ id, access, provider, model, name }) => ({ id, access, provider, model, name }))(loadConfig().roles.custom[0]),
      { id: "docs", access: "write", provider: "claude", model: "claude-haiku-5-5", name: "Docs writer" }
    );
    assert.throws(() => roleAddCommand("docs", { promptFile }), /already exists/);
    assert.throws(() => roleAddCommand("builder", { promptFile }), /reserved/);
    assert.throws(() => roleAddCommand("ops", { promptFile: path.join(TEST_KUMO_HOME, "missing.md") }), /Could not read/);

    roleSetCommand("docs", "sonnet");
    assert.strictEqual(loadConfig().roles.custom[0].model, "claude-sonnet-5-5");
    assert.throws(() => roleRemoveCommand("reviewer"), /built-in role/);
    roleRemoveCommand("docs");
    assert.deepStrictEqual(loadConfig().roles.custom, []);
  });
});

test("the kumo role CLI reports a refused change and exits 1", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-role-cli-"));
  try {
    const run = (...args) =>
      spawnSync(process.execPath, [cliPath, "role", ...args], {
        env: { ...process.env, KUMO_HOME: home, KUMO_NO_SYNC: "1" },
        encoding: "utf-8",
      });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ ...WORKER_ONLY }));
    // Antigravity, the shared worker's provider, has no Haiku: Claude Code runs it.
    const ok = run("set", "tester", "haiku", "low");
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /tester runs on Claude Haiku 5\.5 \(Claude Code\), low effort/);
    const refused = run("set", "tester", "llama3.1", "low", "ollama");
    assert.strictEqual(refused.status, 1);
    assert.match(refused.stderr, /text-only/);
    const list = run();
    assert.strictEqual(list.status, 0, list.stderr);
    assert.match(list.stdout, /tester\s.*worker_test\s.*Claude Haiku 5\.5/);
    assert.match(list.stdout, /designer\s.*worker_design\s.*Gemini 3\.8 Flash.*shared worker/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("/role and kumo role build the same patch for a session's settings", () => {
  const settings = { ...WORKER_ONLY, orchestratorProvider: "codex", roles: normalizeRoles({ custom: [DOCS_ROLE] }) };
  assert.deepStrictEqual(roleSetPatch(settings, "reviewer", "astra", "high").roles.reviewer, {
    provider: "codex",
    model: "gpt-6-astra",
    effort: "high",
  });
  assert.deepStrictEqual(roleSetPatch(settings, "lead", "opus"), { orchestratorProvider: "claude", orchestratorModel: "claude-opus-5-5" });
});

// ── the bridge ──

/**
 * A real bridge over stdio whose saved config is `config`; the stub worker
 * stands in for both Codex and Claude Code.
 */
async function withBridge(config, fn) {
  const fixture = makeFixture({ reply: "stub reply" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-roles-home-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--workspace", fixture.dir],
    cwd: fixture.dir,
    env: { ...process.env, KUMO_HOME: home, KUMO_NO_SYNC: "1", CODEX_BIN: fixture.stub, CLAUDE_BIN: fixture.stub },
  });
  const client = new Client({ name: "roles-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client, fixture);
  } finally {
    await transport.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const ROUTED_CONFIG = {
  workerProvider: "claude",
  workerModel: "claude-haiku-5-5",
  workerEffort: "low",
  safetyMode: "autonomous",
  roles: {
    builder: { provider: "codex", model: "gpt-6-sol", effort: "medium" },
    reviewer: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
    custom: [DOCS_ROLE, { id: "triage", name: "Triage", description: "Sort incoming bug reports", prompt: "Classify the report.", access: "read" }],
  },
};

test("the bridge registers a tool per role, custom ones included, each naming its role and model", { timeout: 60000 }, async () => {
  await withBridge(ROUTED_CONFIG, async (client) => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepStrictEqual(Object.keys(byName).sort(), [
      "worker_design",
      "worker_docs",
      "worker_explore",
      "worker_implement",
      "worker_research",
      "worker_review",
      "worker_test",
      "worker_triage",
    ]);
    assert.match(byName.worker_implement.description, /^Builder role, runs on GPT-6 Sol \(Codex\), medium effort\./);
    assert.match(byName.worker_review.description, /^Reviewer role, runs on Claude Opus 5\.5 \(Claude Code\), high effort\./);
    assert.match(byName.worker_explore.description, /^Scout role, runs on Claude Haiku 5\.5 \(Claude Code\), low effort \(the shared worker\)\./);
    assert.match(byName.worker_docs.description, /^Docs writer role \(custom\), runs on .*Use for README and guide edits\. Can modify workspace files\.$/);
    assert.match(byName.worker_triage.description, /Sort incoming bug reports\. Read-only\.$/);
    // Write roles take the two-phase confirmation; read roles do not.
    assert.ok(byName.worker_docs.inputSchema.properties.confirm);
    assert.ok(byName.worker_design.inputSchema.properties.previewId);
    assert.strictEqual(byName.worker_triage.inputSchema.properties.confirm, undefined);
  });
});

test("each role's calls run on that role's model, with its own prompt", { timeout: 60000 }, async () => {
  await withBridge(ROUTED_CONFIG, async (client, fixture) => {
    await client.callTool({ name: "worker_explore", arguments: { task: "map the repo" } });
    await client.callTool({ name: "worker_implement", arguments: { task: "implement the change" } });
    await client.callTool({ name: "worker_review", arguments: { task: "review it" } });
    const triaged = await client.callTool({ name: "worker_triage", arguments: { task: "sort this report" } });
    assert.match(textOf(triaged), /stub reply/);

    const [scout, builder, reviewer, triage] = fixture.calls();
    assert.ok(isClaude(scout) && modelOf(scout) === "claude-haiku-5-5", "scout: the shared worker");
    assert.ok(isCodex(builder) && modelOf(builder) === "gpt-6-sol", "builder: its own provider and model");
    assert.strictEqual(builder.args[builder.args.indexOf("--sandbox") + 1], "workspace-write");
    assert.ok(isClaude(reviewer) && modelOf(reviewer) === "claude-opus-5-5");
    assert.ok(!reviewer.args.includes("--dangerously-skip-permissions"), "a read role stays read-only");
    const prompt = triage.args.join(" ") + triage.stdin;
    assert.match(prompt, /Classify the report\./, "a custom role's prompt reaches its worker");
    assert.ok(triage.args.includes("--disallowedTools"), "a read custom role cannot edit");
  });
});

test("a custom write role on a text-only shared worker is refused, not run", { timeout: 60000 }, async () => {
  await withBridge({ ...ROUTED_CONFIG, workerProvider: "ollama", workerModel: "llama3.1" }, async (client, fixture) => {
    const res = await client.callTool({ name: "worker_docs", arguments: { task: "fix the README", files: ["target.txt"] } });
    assert.match(textOf(res), /\[REFUSED\].*cannot modify files/);
    assert.strictEqual(fixture.calls().length, 0);
  });
});
