import "./helpers/env.js";
/**
 * codex-protocol.test.js — CodexAppClient against real app-server message shapes.
 *
 * The older client tests used hand-invented payloads (`type: "tool_call"`,
 * `name: "worker_explore"`). Codex actually sends `type: "mcpToolCall"` with
 * `server` and `tool`, so the REPL matched none of its tool calls while every
 * test stayed green. These fixtures follow the generated protocol schema, and
 * the last test re-checks them against a freshly generated schema when a real
 * codex binary is available (KUMO_LIVE_TESTS=1).
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CodexAppClient, bridgeEnvVarNames } from "../src/providers/orchestrators/codex-client.js";
import { findCodexBinary } from "../src/providers/orchestrators/codex.js";
import { isToolCallItem, toolNameOf } from "../src/providers/orchestrators/items.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "codex-protocol.json"), "utf-8"));
const msg = (name) => structuredClone(fixtures[name].message);

/** A client wired to an in-memory stdin, so replies can be inspected. */
function clientWithFakeStdin() {
  const client = new CodexAppClient({ bin: "codex-not-spawned" });
  const written = [];
  client.proc = { stdin: { writable: true, write: (line) => written.push(JSON.parse(line)) } };
  const feed = (message) => client._handleStdout(Buffer.from(JSON.stringify(message) + "\n"));
  return { client, written, feed };
}

test("a real mcpToolCall item is recognized as a tool call, with its id and tool name", () => {
  const { client, feed } = clientWithFakeStdin();
  const started = [];
  const completed = [];
  client.on("item_started", (p) => started.push(p.item));
  client.on("item_completed", (p) => completed.push(p.item));

  feed(msg("itemStartedMcp"));
  feed(msg("itemCompletedMcp"));

  assert.strictEqual(started.length, 1);
  assert.ok(isToolCallItem(started[0]), "the REPL must see mcpToolCall as a tool call");
  assert.strictEqual(toolNameOf(started[0]), "worker_explore");
  assert.strictEqual(started[0].id, "call_7f3a", "Codex's own id must be kept");
  assert.strictEqual(completed[0].id, "call_7f3a");
});

test("turn/completed reports the turn's real status", () => {
  const { client, feed } = clientWithFakeStdin();
  const outcomes = [];
  client.on("turn_completed", (p) => outcomes.push({ ok: p.ok, reason: p.reason }));

  feed(msg("turnCompletedOk"));
  feed(msg("turnCompletedFailed"));

  assert.deepStrictEqual(outcomes, [
    { ok: true, reason: undefined },
    { ok: false, reason: "usage limit reached" },
  ]);
});

test("a retryable error is a warning; only a final error ends the turn", () => {
  const { client, feed } = clientWithFakeStdin();
  const warnings = [];
  const errors = [];
  client.on("warning", (w) => warnings.push(w.message));
  client.on("server_error", (e) => errors.push(e.message));

  feed(msg("errorWillRetry"));
  assert.deepStrictEqual(errors, [], "Codex retries this itself; the turn must keep running");
  assert.deepStrictEqual(warnings, ["stream disconnected; retrying"]);

  feed(msg("errorFinal"));
  assert.deepStrictEqual(errors, ["model not available"]);
});

test("a server request is never mistaken for the reply to our own request with the same id", async () => {
  const { client, written, feed } = clientWithFakeStdin();
  // Our request gets id 1 — and so does the server's first request.
  const pending = client.request("thread/start", {});
  let resolved = false;
  pending.then(() => (resolved = true));

  feed(msg("commandApprovalRequest"));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(resolved, false, "the approval request must not resolve thread/start");

  // With nobody listening, Kumo answers with the protocol's refusal instead of
  // leaving Codex blocked until the turn times out.
  const reply = written.find((m) => m.id === 1 && "result" in m);
  assert.deepStrictEqual(reply, { jsonrpc: "2.0", id: 1, result: { decision: "decline" } });

  feed({ jsonrpc: "2.0", id: 1, result: { thread: { id: "thr_1" } } });
  assert.deepStrictEqual(await pending, { thread: { id: "thr_1" } });
});

test("a listener can approve or decline an approval request", () => {
  const { client, written, feed } = clientWithFakeStdin();
  const seen = [];
  client.on("server_request", (req) => {
    seen.push(req);
    if (req.params.command?.includes("left-pad")) req.approve();
    else req.decline();
  });

  feed(msg("commandApprovalRequest"));
  feed({ jsonrpc: "2.0", id: "legacy-1", method: "execCommandApproval", params: { command: ["rm", "-rf", "build"] } });

  assert.strictEqual(seen[0].isApproval, true);
  assert.match(seen[0].description, /npm install left-pad/);
  assert.deepStrictEqual(written[0], { jsonrpc: "2.0", id: 1, result: { decision: "accept" } });
  assert.deepStrictEqual(written[1], { jsonrpc: "2.0", id: "legacy-1", result: { decision: "denied" } });
});

test("Codex's approval for a kumo-bridge tool call is granted without asking", () => {
  // Found by a live run: Codex asks before *every* MCP tool call. Unanswered,
  // the turn hung; declined, every delegation failed with "user rejected".
  const { client, written, feed } = clientWithFakeStdin();
  const prompted = [];
  client.on("server_request", (req) => prompted.push(req));

  feed(msg("mcpToolApprovalBridge"));

  assert.deepStrictEqual(written[0], { jsonrpc: "2.0", id: 0, result: { action: "accept", content: {} } });
  assert.strictEqual(prompted.length, 0, "the operator is not asked about Kumo's own tools");
});

test("a tool-call approval for another MCP server is put to the operator", () => {
  const { client, written, feed } = clientWithFakeStdin();
  const prompted = [];
  client.on("server_request", (req) => {
    prompted.push(req);
    req.approve();
  });

  const other = msg("mcpToolApprovalBridge");
  other.params.serverName = "someone-elses-server";
  other.params.message = 'Allow the someone-elses-server MCP server to run tool "delete_all"?';
  feed(other);

  assert.strictEqual(prompted.length, 1);
  assert.strictEqual(prompted[0].isApproval, true);
  assert.match(prompted[0].description, /delete_all/);
  assert.deepStrictEqual(written[0].result, { action: "accept", content: {} });
});

test("an unsupported server request gets a JSON-RPC error, not silence", () => {
  const { written, feed } = clientWithFakeStdin();
  feed({ jsonrpc: "2.0", id: 9, method: "attestation/generate", params: {} });
  assert.strictEqual(written[0].id, 9);
  assert.strictEqual(written[0].error.code, -32601);
});

/** Answer the next request with `method` once the client has sent it. */
async function answer(written, feed, method, result) {
  for (let i = 0; i < 100; i++) {
    const request = written.find((m) => m.method === method && !m.answered);
    if (request) {
      request.answered = true;
      feed({ jsonrpc: "2.0", id: request.id, result });
      return request;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`client never sent ${method}`);
}

test("startThread hands Codex the bridge without --model/--effort and writes nothing to the repo", async () => {
  const { client, written, feed } = clientWithFakeStdin();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-codex-ws-"));
  try {
    const started = client.startThread({ workspace: ws, model: "gpt-5.6-terra", reasoningEffort: "low" });
    await answer(written, feed, "model/list", { data: [{ id: "gpt-5.6-terra", isDefault: true }] });
    const request = await answer(written, feed, "thread/start", { thread: { id: "thr_9" } });
    assert.strictEqual(await started, "thr_9");

    const bridge = request.params.config.mcp_servers["kumo-bridge"];
    assert.deepStrictEqual(bridge.args.slice(1), ["--workspace", ws]);
    // Codex filters the environment of MCP servers; the session's Kumo
    // variables must be forwarded by name or the bridge never sees them.
    assert.ok(bridge.env_vars.includes("KUMO_HOME"), "the sandboxed KUMO_HOME must reach the bridge");
    assert.ok(!("env" in bridge), "values are never copied into the thread config");
    // A fixed --model would pin the worker for the whole thread and ignore /model worker.
    assert.ok(!bridge.args.includes("--model") && !bridge.args.includes("--effort"));
    assert.deepStrictEqual(fs.readdirSync(ws), [], "no provider files may be written into the workspace");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("startThread warns when the configured model is not offered to this account", async () => {
  // Seen live: Kumo's default `chatgpt-6-astra` is rejected for ChatGPT
  // accounts, but only at the first turn and only as `model_not_found`.
  const { client, written, feed } = clientWithFakeStdin();
  const warnings = [];
  client.on("warning", (w) => warnings.push(w.message));

  const started = client.startThread({ workspace: os.tmpdir(), model: "chatgpt-6-astra" });
  await answer(written, feed, "model/list", {
    data: [{ id: "gpt-5.6-terra", isDefault: true }, { id: "gpt-5.6-luna" }],
  });
  await answer(written, feed, "thread/start", { thread: { id: "thr_1" } });
  await started;

  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /'chatgpt-6-astra' is not available/);
  assert.match(warnings[0], /gpt-5\.6-terra \(default\), gpt-5\.6-luna/);
});

test("the first turn waits until the bridge MCP server is ready", async () => {
  // Seen live: a turn sent while kumo-bridge was still `starting` had no worker
  // tools, and the model answered that it could not delegate.
  const { client, written, feed } = clientWithFakeStdin();
  client.threadId = "thr_1";
  feed({ method: "mcpServer/startupStatus/updated", params: { threadId: "thr_1", name: "kumo-bridge", status: "starting" } });

  const turn = client.startTurn("go");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!written.some((m) => m.method === "turn/start"), "no turn while the bridge is starting");

  feed({ method: "mcpServer/startupStatus/updated", params: { threadId: "thr_1", name: "kumo-bridge", status: "ready" } });
  await answer(written, feed, "turn/start", { turn: { id: "turn_1" } });
  assert.deepStrictEqual(await turn, { turnId: "turn_1" });
});

test("a bridge that failed to start is reported before the turn", async () => {
  const { client, written, feed } = clientWithFakeStdin();
  const warnings = [];
  client.on("warning", (w) => warnings.push(w.message));
  client.threadId = "thr_2";
  feed({
    method: "mcpServer/startupStatus/updated",
    params: { threadId: "thr_2", name: "kumo-bridge", status: "failed", error: "spawn node ENOENT" },
  });
  const turn = client.startTurn("go");
  await answer(written, feed, "turn/start", { turn: { id: "turn_2" } });
  await turn;
  assert.match(warnings[0], /kumo-bridge failed: spawn node ENOENT/);
});

test("events from an interrupted turn do not leak into the next one", () => {
  const { client, feed } = clientWithFakeStdin();
  const deltas = [];
  const completions = [];
  client.on("delta", (d) => deltas.push(d));
  client.on("turn_completed", (p) => completions.push(p.turn?.id));
  client.activeTurnId = "turn_new";

  feed({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "turn_old", itemId: "i", delta: "stale" } });
  feed({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn_old", items: [], status: "interrupted" } } });
  feed({ method: "item/agentMessage/delta", params: { threadId: "t", turnId: "turn_new", itemId: "i", delta: "fresh" } });

  assert.deepStrictEqual(deltas, ["fresh"]);
  assert.deepStrictEqual(completions, [], "the old turn's completion must not end the new turn");
});

test("an interrupt sent before Codex names the turn is delivered once it does", async () => {
  const { client, written, feed } = clientWithFakeStdin();
  client.threadId = "thr_3";
  feed({ method: "mcpServer/startupStatus/updated", params: { threadId: "thr_3", name: "kumo-bridge", status: "ready" } });

  const turn = client.startTurn("go");
  for (let i = 0; i < 50 && !written.some((m) => m.method === "turn/start"); i++) {
    await new Promise((r) => setImmediate(r));
  }
  await client.interruptTurn(); // Ctrl+C before the turn/start response
  assert.ok(!written.some((m) => m.method === "turn/interrupt"), "no turn id to interrupt yet");

  await answer(written, feed, "turn/start", { turn: { id: "turn_3" } });
  const interrupt = await answer(written, feed, "turn/interrupt", {});
  await turn;
  assert.deepStrictEqual(interrupt.params, { threadId: "thr_3", turnId: "turn_3" });
});

test("the bridge gets the session's Kumo settings and API keys, by name only", () => {
  const names = bridgeEnvVarNames({
    KUMO_INTERACTIVE_APPROVAL: "1",
    KUMO_SAFETY_MODE: "interactive",
    OPENAI_API_KEY: "sk-secret",
    AGY_BIN: "C:\\agy.exe",
    HOME: "/home/u",
    AWS_SECRET_ACCESS_KEY: "nope",
    KUMO_UNSET: undefined,
  });
  assert.deepStrictEqual(names, ["AGY_BIN", "KUMO_INTERACTIVE_APPROVAL", "KUMO_SAFETY_MODE", "OPENAI_API_KEY"]);
});

/**
 * Check that `value` carries every property the schema definition requires.
 * Not a full JSON Schema validator: enough to catch a fixture that drifted
 * from the protocol (a renamed field, a wrong item type).
 */
function assertRequired(defs, defName, value, where) {
  const def = defs[defName];
  assert.ok(def, `${where}: schema has no definition ${defName}`);
  for (const key of def.required || []) {
    assert.ok(key in value, `${where}: missing required field '${key}' of ${defName}`);
  }
}

test(
  "fixtures match the schema of the installed Codex app-server",
  { skip: process.env.KUMO_LIVE_TESTS !== "1" && "set KUMO_LIVE_TESTS=1 to check against a real codex binary" },
  () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-codex-schema-"));
    try {
      execFileSync(findCodexBinary(), ["app-server", "generate-json-schema", "--out", out], { stdio: "ignore" });
      const v2 = JSON.parse(fs.readFileSync(path.join(out, "codex_app_server_protocol.v2.schemas.json"), "utf-8"));
      const serverRequests = JSON.parse(fs.readFileSync(path.join(out, "ServerRequest.json"), "utf-8"));
      const defs = { ...v2.definitions, ...serverRequests.definitions };
      const itemVariants = Object.fromEntries(
        defs.ThreadItem.oneOf.map((variant) => [variant.properties.type.enum[0], variant])
      );

      for (const [name, { schema, message }] of Object.entries(fixtures)) {
        if (name.startsWith("_")) continue;
        assertRequired(defs, schema, message.params, name);
        const item = message.params.item;
        if (item) {
          const variant = itemVariants[item.type];
          assert.ok(variant, `${name}: item type '${item.type}' is not a ThreadItem type`);
          for (const key of variant.required || []) {
            assert.ok(key in item, `${name}: item is missing required field '${key}'`);
          }
        }
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }
);
