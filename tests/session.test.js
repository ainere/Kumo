import "./helpers/env.js";
/**
 * session.test.js — The engine's Session, driven through a scripted client.
 *
 * Every event is validated against its schema (KUMO_STRICT_EVENTS is set by
 * helpers/env.js). The IPC tests talk to the session over its real endpoint
 * with the same client the bridge uses.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Session } from "../src/core/session.js";
import { SessionManager } from "../src/core/session-manager.js";
import { ToolTracker } from "../src/core/tool-tracker.js";
import { connectEngine } from "../src/core/ipc/engine-client.js";
import { loadConfig } from "../src/config/settings.js";
import { getLiveLogPath, updateChat } from "../src/data/sessions.js";

const SETTINGS = {
  orchestratorProvider: "codex",
  orchestratorModel: "gpt-6-astra",
  reasoningEffort: "low",
  workerProvider: "codex",
  workerModel: "gpt-6-luna",
  workerEffort: "low",
  safetyMode: "autonomous",
  timeoutMs: 300000,
  turnTimeoutMs: 60000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let threadSeq = 0;

/** The default turn: two deltas, then success. */
function answer(client) {
  client.emit("delta", "Hello ");
  client.emit("delta", "world");
  client.emit("turn_completed", { ok: true });
}

/**
 * A client with the shape the real ones have; `turn(client, prompt)` plays
 * out each turn after startTurn resolves.
 */
function fakeClient({ turn = answer, limits = null } = {}) {
  const c = new EventEmitter();
  c.calls = [];
  c.thread = null;
  c.start = async () => c.calls.push("start");
  c.startThread = async (o) => {
    c.calls.push(["startThread", o.workspace]);
    c.thread = `thread-${++threadSeq}`;
  };
  c.resumeThread = async (o) => {
    c.calls.push(["resumeThread", o.threadId]);
    c.thread = o.threadId;
  };
  c.currentThreadId = () => c.thread;
  c.applyModel = async (o) => c.calls.push(["applyModel", o.model]);
  c.startTurn = async (prompt, opts) => {
    c.calls.push(["startTurn", prompt, opts.model]);
    setImmediate(() => turn(c, prompt));
    return { turnId: "t" };
  };
  c.interruptTurn = async () => {
    c.calls.push("interrupt");
    c.emit("turn_completed", { ok: false, reason: "interrupted" });
  };
  c.stop = async () => c.calls.push("stop");
  c.getRateLimits = async () => limits;
  return c;
}

/** A session on a fresh workspace whose clients are recorded in `created`. */
function makeSession(opts = {}, behavior = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-session-"));
  const created = [];
  const session = new Session({
    workspace,
    settings: { ...SETTINGS, ...(opts.settings || {}) },
    quotas: false,
    createClient: (clientOpts) => {
      const client = fakeClient(behavior);
      created.push({ client, opts: clientOpts });
      return client;
    },
    ...opts,
    ...(opts.settings ? { settings: { ...SETTINGS, ...opts.settings } } : {}),
  });
  const events = [];
  session.on("event", (e) => events.push(e));
  const cleanup = async () => {
    await session.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  };
  return { session, workspace, created, events, cleanup, client: () => created.at(-1)?.client };
}

test("a turn streams its answer, completes, and is saved with its provider thread", async () => {
  const { session, events, cleanup, client } = makeSession();
  try {
    await session.start();
    const outcome = await session.send("hi there");
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.text, "Hello world");
    assert.deepStrictEqual(
      events.filter((e) => e.type.startsWith("turn.")).map((e) => e.type),
      ["turn.started", "turn.delta", "turn.delta", "turn.completed"]
    );

    const chat = session.listChats().find((c) => c.id === session.chatId);
    assert.strictEqual(chat.provider, "codex");
    assert.strictEqual(chat.threadId, client().thread, "the provider thread is recorded for resuming later");
    assert.strictEqual(chat.title, "hi there");
    assert.strictEqual(session.turnLog()[0].responseSummary, "Hello world");
  } finally {
    await cleanup();
  }
});

test("a failed turn is reported once and not saved", async () => {
  const { session, events, cleanup } = makeSession(
    {},
    { turn: (c) => c.emit("turn_completed", { ok: false, reason: "usage limit reached" }) }
  );
  try {
    const outcome = await session.send("hi");
    assert.deepStrictEqual([outcome.ok, outcome.reason], [false, "usage limit reached"]);
    assert.deepStrictEqual(
      events.filter((e) => e.type.startsWith("turn.")).map((e) => e.type),
      ["turn.started", "turn.failed"]
    );
    assert.deepStrictEqual(session.turnLog(), []);
  } finally {
    await cleanup();
  }
});

test("interrupting stops the orchestrator, and send resolves only once it has", async () => {
  const { session, cleanup, client } = makeSession({}, { turn: () => {} });
  try {
    await session.start();
    const pending = session.send("long task");
    await sleep(30);
    assert.strictEqual(session.busy, true);
    await assert.rejects(session.send("second"), /already running/, "a second turn cannot start on top");
    session.interrupt();
    const outcome = await pending;
    assert.strictEqual(outcome.interrupted, true);
    assert.ok(client().calls.includes("interrupt"));
    assert.strictEqual(session.busy, false);
  } finally {
    await cleanup();
  }
});

test("switching back to a chat resumes its provider thread", async () => {
  const { session, events, cleanup, client, workspace, created } = makeSession();
  try {
    await session.send("first chat");
    const first = session.chatId;
    const firstThread = client().thread;

    await session.newChat();
    assert.notStrictEqual(client().thread, firstThread, "a new chat is a new thread");
    await session.send("second chat");

    const { resumed } = await session.openChat(first);
    assert.strictEqual(resumed, true);
    assert.deepStrictEqual(client().calls.at(-1), ["resumeThread", firstThread]);
    const changed = events.filter((e) => e.type === "chat.changed").at(-1);
    assert.strictEqual(changed.resumed, true);

    // A new session opened on that chat resumes it at start.
    const again = new Session({
      workspace,
      chatId: first,
      settings: SETTINGS,
      quotas: false,
      createClient: () => {
        const c = fakeClient();
        created.push({ client: c });
        return c;
      },
    });
    const ready = new Promise((r) => again.on("event", (e) => e.type === "session.ready" && r(e)));
    await again.start();
    assert.strictEqual((await ready).resumed, true);
    assert.deepStrictEqual(created.at(-1).client.calls.find((c) => Array.isArray(c) && c[0] === "resumeThread"), [
      "resumeThread",
      firstThread,
    ]);
    await again.stop();
  } finally {
    await cleanup();
  }
});

test("a chat recorded under another provider starts a fresh thread instead of resuming", async () => {
  const { session, workspace, cleanup } = makeSession();
  try {
    await session.send("hello");
    const chatId = session.chatId;
    updateChat(workspace, chatId, { provider: "claude" });
    await session.newChat();
    const { resumed } = await session.openChat(chatId);
    assert.strictEqual(resumed, false);
  } finally {
    await cleanup();
  }
});

test("settings: worker changes need no restart, model changes keep the thread, provider changes reconnect", async () => {
  const { session, created, cleanup, client } = makeSession();
  try {
    await session.start();
    const before = loadConfig().workerModel;

    assert.deepStrictEqual(await session.updateSettings({ workerModel: "gpt-6-sol" }), ["workerModel"]);
    assert.strictEqual(created.length, 1, "no new orchestrator for a worker change");
    assert.strictEqual(loadConfig().workerModel, before, "a session change does not touch the saved defaults");

    const thread = client().thread;
    await session.updateSettings({ orchestratorModel: "gpt-6.1-sol" });
    assert.deepStrictEqual(client().calls.at(-1), ["applyModel", "gpt-6.1-sol"]);
    await session.send("next");
    assert.deepStrictEqual(client().calls.find((c) => c[0] === "startTurn").slice(2), ["gpt-6.1-sol"]);
    assert.strictEqual(client().thread, thread, "the conversation carries on");

    await session.updateSettings({ orchestratorProvider: "claude", orchestratorModel: "claude-opus-5-5" });
    assert.strictEqual(created.length, 2);
    assert.strictEqual(created[1].opts.provider, "claude");

    await assert.rejects(session.updateSettings({ reasoningEffort: "turbo" }), /must be one of/);

    await session.updateSettings({ workerEffort: "high" }, { persist: true });
    assert.strictEqual(loadConfig().workerEffort, "high", "persist: true saves it as the default");
  } finally {
    await cleanup();
  }
});

test("each session answers the bridge with its own settings, and only with the right token", async () => {
  const manager = new SessionManager({
    defaults: () => ({ ...loadConfig(), ...SETTINGS }),
    sessionOptions: { quotas: false, createClient: () => fakeClient() },
  });
  const dirs = [fs.mkdtempSync(path.join(os.tmpdir(), "kumo-a-")), fs.mkdtempSync(path.join(os.tmpdir(), "kumo-b-"))];
  try {
    const a = await manager.create({ workspace: dirs[0], settings: { workerModel: "gpt-6-sol" } });
    const b = await manager.create({ workspace: dirs[1] });
    const bridgeA = await connectEngine({ endpoint: a.ipc.endpoint, token: a.ipc.token });
    const bridgeB = await connectEngine({ endpoint: b.ipc.endpoint, token: b.ipc.token });
    assert.strictEqual(bridgeA.hello.sessionId, a.id);

    assert.strictEqual((await bridgeA.request("settings.get")).workerModel, "gpt-6-sol");
    assert.strictEqual((await bridgeB.request("settings.get")).workerModel, "gpt-6-luna");
    await b.updateSettings({ safetyMode: "diff-review" });
    assert.strictEqual((await bridgeB.request("settings.get")).safetyMode, "diff-review");
    assert.strictEqual((await bridgeA.request("settings.get")).safetyMode, "autonomous", "one window's switch stays there");

    assert.strictEqual(await connectEngine({ endpoint: a.ipc.endpoint, token: "wrong" }), null);
    assert.strictEqual(await connectEngine({ endpoint: a.ipc.endpoint, token: b.ipc.token }), null);
    bridgeA.close();
    bridgeB.close();
  } finally {
    await manager.closeAll();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("parallel worker calls each get their own output", async () => {
  // Before, every call's tailer adopted "the newest active run", so two
  // concurrent calls streamed the same log.
  let bridge;
  const { session, events, cleanup } = makeSession(
    {},
    {
      turn: async (c) => {
        const item = (id, task) => ({ item: { id, type: "mcpToolCall", server: "kumo-bridge", tool: "worker_explore", arguments: { task } } });
        c.emit("item_started", item("call-a", "look at A"));
        c.emit("item_started", item("call-b", "look at B"));
        bridge.notify("run.started", { runId: "run-b", tool: "worker_explore", task: "look at B" });
        bridge.notify("run.started", { runId: "run-a", tool: "worker_explore", task: "look at A" });
        bridge.notify("run.output", { runId: "run-a", text: "output of A" });
        bridge.notify("run.output", { runId: "run-b", text: "output of B" });
        await sleep(100);
        c.emit("item_completed", item("call-a", "look at A"));
        c.emit("item_completed", item("call-b", "look at B"));
        c.emit("turn_completed", { ok: true });
      },
    }
  );
  try {
    await session.start();
    bridge = await connectEngine({ endpoint: session.ipc.endpoint, token: session.ipc.token });
    await session.send("compare A and B");
    const output = (id) => events.filter((e) => e.type === "tool.output" && e.toolId === id).map((e) => e.text).join("");
    assert.strictEqual(output("call-a"), "output of A");
    assert.strictEqual(output("call-b"), "output of B");
    assert.deepStrictEqual(
      events.filter((e) => e.type === "tool.completed").map((e) => [e.toolId, e.ok]),
      [["call-a", true], ["call-b", true]]
    );
    bridge.close();
  } finally {
    await cleanup();
  }
});

test("output that arrives before the orchestrator reports its call is held, then delivered", async () => {
  let bridge;
  const { session, events, cleanup } = makeSession(
    {},
    {
      turn: async (c) => {
        bridge.notify("run.started", { runId: "run-1", tool: "worker_test", task: "run the tests" });
        bridge.notify("run.output", { runId: "run-1", text: "early " });
        await sleep(60);
        const item = { item: { id: "call-1", type: "mcpToolCall", tool: "worker_test", arguments: { task: "run the tests" } } };
        c.emit("item_started", item);
        bridge.notify("run.output", { runId: "run-1", text: "late" });
        await sleep(60);
        c.emit("item_completed", item);
        c.emit("turn_completed", { ok: true });
      },
    }
  );
  try {
    await session.start();
    bridge = await connectEngine({ endpoint: session.ipc.endpoint, token: session.ipc.token });
    await session.send("test it");
    const text = events.filter((e) => e.type === "tool.output").map((e) => e.text).join("");
    assert.strictEqual(text, "early late");
    bridge.close();
  } finally {
    await cleanup();
  }
});

test("write approvals reach the operator over the engine connection; without one they are refused", async () => {
  const interactive = makeSession({ interactive: true, settings: { safetyMode: "interactive" } });
  const headless = makeSession({ interactive: false });
  try {
    await interactive.session.start();
    await headless.session.start();
    const bridge = await connectEngine({ endpoint: interactive.session.ipc.endpoint, token: interactive.session.ipc.token });
    assert.strictEqual(bridge.hello.interactive, true);

    interactive.session.on("event", (e) => {
      if (e.type === "approval.requested") interactive.session.resolveApproval(e.approvalId, true);
    });
    const decision = await bridge.request("approval.request", { previewId: "prev_1", tool: "worker_implement", previewText: "--- a/x\n+++ b/x" });
    assert.deepStrictEqual(decision, { approved: true });
    const requested = interactive.events.find((e) => e.type === "approval.requested");
    assert.strictEqual(requested.kind, "write");
    assert.match(requested.preview, /\+\+\+ b\/x/);

    const other = await connectEngine({ endpoint: headless.session.ipc.endpoint, token: headless.session.ipc.token });
    assert.strictEqual(other.hello.interactive, false);
    const refused = await other.request("approval.request", { previewId: "prev_2", tool: "worker_implement", previewText: "" });
    assert.strictEqual(refused.approved, false);
    bridge.close();
    other.close();
  } finally {
    await interactive.cleanup();
    await headless.cleanup();
  }
});

test("an orchestrator's own approval request is asked when someone is there, declined otherwise", async () => {
  const request = () => {
    const req = { isApproval: true, method: "item/commandExecution/requestApproval", description: "Command: rm -rf build" };
    req.result = new Promise((resolve) => {
      req.approve = () => resolve("approved");
      req.decline = () => resolve("declined");
    });
    return req;
  };
  const asked = makeSession({ interactive: true }, { turn: () => {} });
  const nobody = makeSession({ interactive: false }, { turn: () => {} });
  try {
    await asked.session.start();
    await nobody.session.start();

    const r1 = request();
    asked.session.on("event", (e) => {
      if (e.type === "approval.requested") asked.session.resolveApproval(e.approvalId, false);
    });
    asked.client().emit("server_request", r1);
    assert.strictEqual(await r1.result, "declined");
    assert.strictEqual(asked.events.find((e) => e.type === "approval.requested").kind, "orchestrator");

    const r2 = request();
    nobody.client().emit("server_request", r2);
    assert.strictEqual(await r2.result, "declined");
    assert.ok(nobody.events.some((e) => e.type === "session.warning" && /Declined/.test(e.message)));
  } finally {
    await asked.cleanup();
    await nobody.cleanup();
  }
});

test("without an engine connection, worker output is read from the bridge's live-log file", async () => {
  let workspace;
  const { session, events, cleanup, workspace: ws } = makeSession(
    { ipc: false },
    {
      turn: async (c) => {
        const item = { item: { id: "call-x", type: "mcpToolCall", tool: "worker_explore", arguments: { task: "t" } } };
        c.emit("item_started", item);
        fs.appendFileSync(getLiveLogPath(workspace, "call-x"), "hello from the file");
        await sleep(250);
        c.emit("item_completed", item);
        c.emit("turn_completed", { ok: true });
      },
    }
  );
  workspace = ws;
  try {
    await session.send("explore");
    const text = events.filter((e) => e.type === "tool.output" && e.toolId === "call-x").map((e) => e.text).join("");
    assert.strictEqual(text, "hello from the file");
    assert.strictEqual(fs.existsSync(getLiveLogPath(workspace, "call-x")), false, "the finished log is removed");
  } finally {
    await cleanup();
  }
});

test("a closed session refuses work", async () => {
  const { session, cleanup } = makeSession();
  await session.start();
  await cleanup();
  await assert.rejects(session.send("hi"), /closed/);
});

test("the tool tracker matches runs by tool and task, and holds output for unmatched runs", () => {
  const tracker = new ToolTracker();
  const call = tracker.start({ id: "c1", type: "mcpToolCall", tool: "worker_review", arguments: { task: "review x" } });
  assert.strictEqual(tracker.attachRun({ runId: "r9", tool: "worker_review", task: "something else" }), call, "a lone call of that tool still matches");
  assert.strictEqual(tracker.outputFor("r9", "a").text, "a");
  assert.strictEqual(tracker.outputFor("unknown", "held"), null);
  assert.strictEqual(tracker.start({ id: "x", type: "agentMessage" }), null, "non-tool items are ignored");
  assert.strictEqual(tracker.complete({ id: "c1" }), call);
  assert.deepStrictEqual(tracker.clear(), []);
});

test("a bridge without an engine connection gets its approval through the request-file handshake", async () => {
  const { getApprovalDir } = await import("../src/data/sessions.js");
  let workspace;
  let decision;
  const { session, events, cleanup, workspace: ws } = makeSession(
    { ipc: false, interactive: true, settings: { safetyMode: "interactive" } },
    {
      turn: async (c) => {
        const dir = getApprovalDir(workspace);
        fs.writeFileSync(path.join(dir, "prev_9.json"), JSON.stringify({ previewId: "prev_9", tool: "worker_implement", previewText: "+new" }));
        const decisionFile = path.join(dir, "prev_9.decision.json");
        for (let i = 0; i < 40 && !fs.existsSync(decisionFile); i++) await sleep(50);
        decision = JSON.parse(fs.readFileSync(decisionFile, "utf-8"));
        c.emit("turn_completed", { ok: true });
      },
    }
  );
  workspace = ws;
  session.on("event", (e) => {
    if (e.type === "approval.requested") session.resolveApproval(e.approvalId, true);
  });
  try {
    await session.send("change it");
    assert.strictEqual(decision.approved, true);
    assert.strictEqual(events.find((e) => e.type === "approval.requested").preview, "+new");
  } finally {
    await cleanup();
  }
});
