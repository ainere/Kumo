import "./helpers/env.js";
/**
 * engine-bridge.test.js — A real kumo-bridge working for a real Session.
 *
 * The orchestrator is a stand-in that, like Codex or Claude Code, starts the
 * bridge with the environment the session hands it and calls its tools over
 * MCP. The bridge connects back to the session over the named pipe / unix
 * socket; the worker is a stub CLI. This is the path the desktop app and the
 * CLI both depend on: per-session settings, output tagged with its call, and
 * approvals answered by the operator — with no files in between.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Session } from "../src/core/session.js";
import { normalizeRoles, withRoleAssignment, withCustomRole } from "../src/config/roles.js";
import { makeFixture } from "./helpers/bridge-fixture.js";

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/bridge/server.js");

const textOf = (res) => (res?.content || []).map((c) => c.text || "").join("\n");

/**
 * An orchestrator stand-in. start() launches the bridge with the env the
 * session provides; each turn runs `script(mcp, client)`.
 */
function bridgeBackedClient({ dir, stub, bridgeHome, script }) {
  return (opts) => {
    const c = new EventEmitter();
    let transport;
    c.start = async () => {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath, "--workspace", dir],
        cwd: dir,
        env: { ...process.env, KUMO_HOME: bridgeHome, KUMO_NO_SYNC: "1", CODEX_BIN: stub, CLAUDE_BIN: stub, ...opts.env },
      });
      c.mcp = new Client({ name: "fake-orchestrator", version: "1.0.0" }, { capabilities: {} });
      await c.mcp.connect(transport);
    };
    // A thread id the session can hand back on a restart, as real clients do.
    c.startThread = async () => {
      c.thread = "thread-1";
    };
    c.resumeThread = async ({ threadId }) => {
      c.resumedFrom = threadId;
      c.thread = threadId;
    };
    c.currentThreadId = () => c.thread || null;
    c.startTurn = async () => {
      setImmediate(async () => {
        try {
          await script(c.mcp, c);
          c.emit("turn_completed", { ok: true });
        } catch (err) {
          c.emit("turn_completed", { ok: false, reason: err.message });
        }
      });
      return { turnId: "t" };
    };
    c.interruptTurn = async () => c.emit("turn_completed", { ok: false, reason: "interrupted" });
    c.stop = async () => transport?.close();
    return c;
  };
}

/** Call a bridge tool the way an orchestrator does, reporting it as an item. */
async function callTool(mcp, client, id, name, args) {
  const item = { item: { id, type: "mcpToolCall", server: "kumo-bridge", tool: name, arguments: args } };
  client.emit("item_started", item);
  const res = await mcp.callTool({ name, arguments: args });
  client.emit("item_completed", item);
  return res;
}

function setup({ settings = {}, interactive = false, script }) {
  const fixture = makeFixture({ reply: "stub reply: three files" });
  const bridgeHome = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-bridge-home-"));
  // The saved config points the worker elsewhere; only the session says codex.
  fs.writeFileSync(path.join(bridgeHome, "config.json"), JSON.stringify({ workerProvider: "claude", safetyMode: "autonomous" }));
  const session = new Session({
    workspace: fixture.dir,
    interactive,
    quotas: false,
    persist: false,
    settings: {
      orchestratorProvider: "codex",
      orchestratorModel: "gpt-6-astra",
      reasoningEffort: "low",
      workerProvider: "codex",
      workerModel: "gpt-6-luna",
      workerEffort: "low",
      safetyMode: "autonomous",
      timeoutMs: 60000,
      turnTimeoutMs: 60000,
      ...settings,
    },
    createClient: bridgeBackedClient({ dir: fixture.dir, stub: fixture.stub, bridgeHome, script }),
  });
  const events = [];
  session.on("event", (e) => events.push(e));
  const cleanup = async () => {
    await session.stop();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fs.rmSync(bridgeHome, { recursive: true, force: true });
  };
  return { session, events, fixture, bridgeHome, cleanup };
}

test("the bridge uses the session's settings and streams the worker's output to its call", { timeout: 60000 }, async () => {
  let result;
  const { session, events, fixture, bridgeHome, cleanup } = setup({
    script: async (mcp, client) => {
      result = await callTool(mcp, client, "call-1", "worker_explore", { task: "list the files" });
    },
  });
  try {
    const outcome = await session.send("what is in here?");
    assert.strictEqual(outcome.ok, true, outcome.reason);
    assert.strictEqual(session.ipc.connectedBridges, 1, "the bridge reached the session");

    // The saved config said claude; the session said codex, and won. (One
    // stub stands in for both CLIs, so the command line tells them apart.)
    assert.strictEqual(fixture.calls().length, 1);
    assert.strictEqual(fixture.calls()[0].args[0], "exec", "launched as `codex exec`");
    assert.ok(!fixture.calls()[0].args.includes("--strict-mcp-config"), "not as the Claude worker");
    assert.match(textOf(result), /stub reply: three files/);

    const output = events.filter((e) => e.type === "tool.output" && e.toolId === "call-1").map((e) => e.text).join("");
    assert.match(output, /stub reply: three files/, "the worker's output streamed to the call that started it");

    // Nothing went through files.
    const sessions = path.join(bridgeHome, "sessions");
    const logs = fs.existsSync(sessions)
      ? fs.readdirSync(sessions, { recursive: true }).filter((f) => /live-.*\.log$/.test(String(f)))
      : [];
    assert.deepStrictEqual(logs, []);
  } finally {
    await cleanup();
  }
});

test("interactive mode: the operator approves the change over the engine connection and git applies it", { timeout: 60000 }, async () => {
  let applied;
  const { session, events, fixture, cleanup } = setup({
    interactive: true,
    settings: { safetyMode: "interactive" },
    script: async (mcp, client) => {
      const task = "replace old with new in target.txt";
      const preview = await callTool(mcp, client, "call-1", "worker_implement", { task });
      const previewId = textOf(preview).match(/Preview ID: "([^"]+)"/)?.[1];
      assert.ok(previewId, textOf(preview));
      applied = await callTool(mcp, client, "call-2", "worker_implement", { task, confirm: true, previewId });
    },
  });
  session.on("event", (e) => {
    if (e.type === "approval.requested") session.resolveApproval(e.approvalId, true);
  });
  try {
    const outcome = await session.send("change target.txt");
    assert.strictEqual(outcome.ok, true, outcome.reason);
    const request = events.find((e) => e.type === "approval.requested");
    assert.ok(request, "the bridge asked the session, not a file");
    assert.match(request.preview, /\+new/);
    assert.match(textOf(applied), /exactly as shown/);
    assert.strictEqual(fs.readFileSync(path.join(fixture.dir, "target.txt"), "utf-8").replace(/\r\n/g, "\n"), "new\n");
  } finally {
    await cleanup();
  }
});

test("interactive mode: a declined change is not written", { timeout: 60000 }, async () => {
  let applied;
  const { session, fixture, cleanup } = setup({
    interactive: true,
    settings: { safetyMode: "interactive" },
    script: async (mcp, client) => {
      const task = "replace old with new in target.txt";
      const preview = await callTool(mcp, client, "call-1", "worker_implement", { task });
      const previewId = textOf(preview).match(/Preview ID: "([^"]+)"/)?.[1];
      applied = await callTool(mcp, client, "call-2", "worker_implement", { task, confirm: true, previewId });
    },
  });
  session.on("event", (e) => {
    if (e.type === "approval.requested") session.resolveApproval(e.approvalId, false);
  });
  try {
    await session.send("change target.txt");
    assert.match(textOf(applied), /declined/);
    assert.strictEqual(fs.readFileSync(path.join(fixture.dir, "target.txt"), "utf-8").replace(/\r\n/g, "\n"), "old\n");
  } finally {
    await cleanup();
  }
});

test("roles reach the bridge over the engine connection: its tools, their models, and changes between turns", { timeout: 90000 }, async () => {
  const modelOf = (call) => call.args[call.args.indexOf("--model") + 1];
  const roles = normalizeRoles({
    builder: { provider: "codex", model: "gpt-6-sol", effort: "medium" },
    custom: [{ id: "docs", name: "Docs", description: "Summarize documentation", prompt: "Summarize the docs you are given.", access: "read", provider: "codex", model: "gpt-6.1-sol" }],
  });
  const seen = {};
  const turns = [
    async (mcp, client) => {
      const { tools } = await mcp.listTools();
      seen.first = Object.fromEntries(tools.map((t) => [t.name, t.description]));
      await callTool(mcp, client, "call-1", "worker_docs", { task: "summarize the readme" });
      await callTool(mcp, client, "call-2", "worker_explore", { task: "list the files" });
    },
    async (mcp, client) => {
      await callTool(mcp, client, "call-3", "worker_docs", { task: "summarize it again" });
      const { tools } = await mcp.listTools();
      seen.second = Object.fromEntries(tools.map((t) => [t.name, t.description]));
    },
    async (mcp) => {
      const { tools } = await mcp.listTools();
      seen.third = tools.map((t) => t.name);
    },
  ];
  let turn = 0;
  const { session, events, fixture, cleanup } = setup({
    settings: { roles },
    script: (mcp, client) => turns[turn++](mcp, client),
  });
  try {
    // The saved config has no roles at all: everything below comes from the session.
    assert.strictEqual((await session.send("first")).ok, true);
    assert.ok(seen.first.worker_docs, "the custom role's tool comes from the session's settings");
    assert.match(seen.first.worker_implement, /^Builder role, runs on GPT-6 Sol \(Codex\), medium effort/);
    assert.match(seen.first.worker_docs, /^Docs role \(custom\), runs on GPT-6\.1 Sol \(Codex\)/);
    const [docs, explore] = fixture.calls();
    assert.strictEqual(modelOf(docs), "gpt-6.1-sol");
    assert.match(docs.stdin + docs.args.join(" "), /Summarize the docs you are given/);
    assert.strictEqual(modelOf(explore), "gpt-6-luna", "an unassigned role runs on the session's shared worker");
    const started = events.filter((e) => e.type === "tool.started").map((e) => [e.toolId, e.role, e.model]);
    assert.deepStrictEqual(started, [
      ["call-1", "docs", "gpt-6.1-sol"],
      ["call-2", "scout", "gpt-6-luna"],
    ]);

    // A model switch applies to the very next call, with no restart.
    await session.updateSettings({ roles: withRoleAssignment(session.settings.roles, "docs", { provider: "codex", model: "gpt-6-astra" }) });
    const before = session.client;
    assert.strictEqual((await session.send("second")).ok, true);
    assert.strictEqual(session.client, before, "the orchestrator was not restarted");
    assert.strictEqual(modelOf(fixture.calls()[2]), "gpt-6-astra");
    assert.match(seen.second.worker_docs, /GPT-6 Astra/, "the tool's description follows the new model");

    // A new custom role needs a new tool list: the orchestrator restarts on the same thread.
    await session.updateSettings({
      roles: withCustomRole(session.settings.roles, { id: "ops", name: "Ops", description: "", prompt: "Check the deploy.", access: "read" }),
    });
    assert.notStrictEqual(session.client, before);
    assert.strictEqual(session.client.resumedFrom, "thread-1", "the conversation is resumed, not restarted");
    assert.strictEqual((await session.send("third")).ok, true);
    assert.ok(seen.third.includes("worker_ops"), seen.third.join(", "));
  } finally {
    await cleanup();
  }
});
