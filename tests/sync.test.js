import "./helpers/env.js";
/**
 * sync.test.js — Provider-config synchronization never writes where it should not.
 *
 * The helper sets KUMO_NO_SYNC=1 for the whole suite, which used to leave this
 * path entirely untested. Each test here opts back in for its own duration.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  syncAgentConfigs,
  ensureAntigravityBridgeConfig,
  hasManagedConfigs,
  definedTomlNames,
  REVIEWER_MARKER,
} from "../src/config/sync.js";
import { setConfigValue, applyPreset } from "../src/config/settings.js";

const CONFIG = {
  orchestratorProvider: "codex",
  orchestratorModel: "chatgpt-6-astra",
  reasoningEffort: "low",
  workerProvider: "antigravity",
  workerModel: "gemini-3.8-flash",
  workerEffort: "medium",
  approvalPolicy: "on-request",
};

/** Run `fn` with sync enabled and a fresh temp workspace, then clean up. */
async function withSync(fn) {
  const saved = process.env.KUMO_NO_SYNC;
  delete process.env.KUMO_NO_SYNC;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-sync-"));
  try {
    return await fn(ws);
  } finally {
    if (saved === undefined) delete process.env.KUMO_NO_SYNC;
    else process.env.KUMO_NO_SYNC = saved;
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

/** Every file below `dir`, relative to it. */
function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)));
  }
  return out.sort();
}

test("changing settings writes no provider files into the current directory", async () => {
  // Run from a home directory, this used to rewrite the *global* ~/.codex/config.toml.
  await withSync(async (ws) => {
    fs.mkdirSync(path.join(ws, ".codex")); // like a home directory with Codex installed
    const cwd = process.cwd();
    process.chdir(ws);
    try {
      setConfigValue("orchestratorModel", "gpt-5.6-luna");
      applyPreset("speed");
    } finally {
      process.chdir(cwd);
    }
    assert.deepStrictEqual(listFiles(ws), []);
  });
});

test("syncAgentConfigs needs an explicit workspace", async () => {
  await withSync(async () => {
    assert.deepStrictEqual(syncAgentConfigs(undefined, CONFIG), { written: [], skipped: [] });
  });
});

test("a session refresh leaves workspaces without Kumo-managed files alone", async () => {
  await withSync(async (ws) => {
    syncAgentConfigs(ws, CONFIG, { onlyIfManaged: true });
    assert.deepStrictEqual(listFiles(ws), []);
    assert.strictEqual(hasManagedConfigs(ws), false);
  });
});

test("a reviewer.toml the user wrote is never overwritten", async () => {
  await withSync(async (ws) => {
    const reviewer = path.join(ws, ".codex", "agents", "reviewer.toml");
    fs.mkdirSync(path.dirname(reviewer), { recursive: true });
    fs.writeFileSync(reviewer, 'name = "my-reviewer"\n');

    const report = syncAgentConfigs(ws, CONFIG);

    assert.strictEqual(fs.readFileSync(reviewer, "utf-8"), 'name = "my-reviewer"\n');
    assert.ok(report.skipped.includes(reviewer));
  });
});

test("a Kumo-written reviewer.toml is regenerated with the current models", async () => {
  await withSync(async (ws) => {
    syncAgentConfigs(ws, CONFIG);
    const reviewer = path.join(ws, ".codex", "agents", "reviewer.toml");
    assert.ok(fs.readFileSync(reviewer, "utf-8").startsWith(REVIEWER_MARKER));

    syncAgentConfigs(ws, { ...CONFIG, orchestratorModel: "gpt-5.6-luna" });
    assert.match(fs.readFileSync(reviewer, "utf-8"), /model = "gpt-5\.6-luna"/);
    assert.strictEqual(hasManagedConfigs(ws), true);
  });
});

test("the managed TOML block never redefines a key the user already set", async () => {
  await withSync(async (ws) => {
    const configToml = path.join(ws, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configToml), { recursive: true });
    // Shaped like a real ~/.codex/config.toml: top-level model, then tables.
    fs.writeFileSync(
      configToml,
      ['model = "gpt-6-astra"', 'model_reasoning_effort = "ultra"', "", "[agents]", "enabled = false", ""].join("\n")
    );

    const report = syncAgentConfigs(ws, CONFIG);
    const text = fs.readFileSync(configToml, "utf-8");
    const rootModelLines = text.split("\n").filter((l) => /^\s*model\s*=/.test(l));

    // Two `model =` lines make the file invalid TOML and Codex refuses to start.
    assert.deepStrictEqual(rootModelLines, ['model = "gpt-6-astra"']);
    assert.doesNotMatch(text, /^agents\.enabled/m, "[agents] is the user's table; dotted keys would redefine it");
    assert.match(text, /^mcp_servers\.kumo-bridge\.command = /m);
    assert.ok(report.skipped.some((s) => s.endsWith(":model")));
    assert.ok(report.skipped.some((s) => s.endsWith(":agents.enabled")));

    // Re-running replaces the block in place instead of stacking another one.
    syncAgentConfigs(ws, CONFIG);
    assert.strictEqual(fs.readFileSync(configToml, "utf-8").split("kumo managed block >>>").length, 2);
  });
});

test("definedTomlNames sees root keys and table headers", () => {
  const names = definedTomlNames('a = 1\nb.c = "x"\n# comment\n[agents]\nd = 2\n[mcp_servers.other]\n');
  assert.deepStrictEqual([...names.rootKeys].sort(), ["a", "b.c"]);
  assert.deepStrictEqual([...names.tables].sort(), ["agents", "mcp_servers.other"]);
});

test("definedTomlNames does not mistake lines inside multi-line values for headers", () => {
  // An array element like `["a", "b"],` looks like a table header; treating it
  // as one hid every later root key and produced duplicate definitions.
  const toml = [
    "notify = [",
    '  ["a", "b"],',
    "]",
    'model = "gpt-5.5"',
    'instructions = """',
    "[not a table]",
    'key = "not a key"',
    '"""',
    'approval_policy = "never"',
    "[mcp_servers.kumo-bridge.env]",
    'X = "1"',
  ].join("\n");
  const names = definedTomlNames(toml);
  assert.deepStrictEqual([...names.rootKeys].sort(), ["approval_policy", "instructions", "model", "notify"]);
  assert.deepStrictEqual([...names.tables], ["mcp_servers.kumo-bridge.env"]);
});

test("the managed block skips a key the user already defines as a table", async () => {
  await withSync(async (ws) => {
    const configToml = path.join(ws, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(configToml), { recursive: true });
    fs.writeFileSync(configToml, 'notify = [\n  ["a"],\n]\nmodel = "gpt-5.5"\n\n[mcp_servers.kumo-bridge.env]\nX = "1"\n');

    const report = syncAgentConfigs(ws, CONFIG);
    const text = fs.readFileSync(configToml, "utf-8");

    assert.strictEqual(text.split("\n").filter((l) => /^model\s*=/.test(l)).length, 1);
    assert.doesNotMatch(text, /^mcp_servers\.kumo-bridge\.env = /m, "env is the user's table");
    assert.ok(report.skipped.some((s) => s.endsWith(":mcp_servers.kumo-bridge.env")));
  });
});

test("the Antigravity bridge entry is merged into an existing mcp_config.json", async () => {
  await withSync(async (ws) => {
    const file = path.join(ws, ".agents", "mcp_config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: "my-server" } } }));

    assert.strictEqual(ensureAntigravityBridgeConfig(ws), true);
    const servers = JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers;
    assert.deepStrictEqual(servers.mine, { command: "my-server" });
    assert.strictEqual(servers["kumo-bridge"].env.KUMO_WORKSPACE, ws);
    assert.strictEqual(ensureAntigravityBridgeConfig(ws), false, "an up-to-date entry is not rewritten");
  });
});
