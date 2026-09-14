/**
 * codex-client.test.js — Verification tests for CodexAppClient JSON-RPC protocol.
 */

import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { CodexAppClient } from "../src/providers/orchestrators/codex-client.js";
import { findCodexBinary } from "../src/providers/orchestrators/codex.js";

/**
 * Probe whether the `codex` CLI actually executes (not just resolves).
 * Live-binary tests skip cleanly on runners without the CLI installed
 * instead of failing with `spawn codex ENOENT`. CODEX_BIN alone is not
 * trusted: the pointed binary must run `codex --version` successfully.
 */
function isCodexBinaryAvailable() {
  const bin = process.env.CODEX_BIN || findCodexBinary();
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

test("findCodexBinary locates executable", () => {
  const bin = findCodexBinary();
  assert.ok(bin && bin.length > 0);
});

test("CodexAppClient initializes and retrieves live account rate limits", async (t) => {
  if (!isCodexBinaryAvailable()) {
    t.skip("codex CLI not installed; skipping live rate-limits check");
    return;
  }
  const client = new CodexAppClient();
  // Attach a no-op error listener: safeSpawn emits 'error' on ENOENT and
  // EventEmitter rethrows unhandled 'error' events as uncaught exceptions.
  client.on("error", () => {});
  await client.start();

  try {
    const limits = await client.getRateLimits();
    assert.ok(limits, "Expected rate limit response");
    assert.ok(typeof limits.usedPercent === "number", "usedPercent should be a number");
    assert.ok(limits.planType, "planType should be defined");
    assert.ok(limits.resetFormatted, "resetFormatted should be defined");
  } finally {
    await client.stop();
  }
});

test("CodexAppClient guarantees stable matching item.id across item_started and item_completed", () => {
  const client = new CodexAppClient();
  const started = [];
  const completed = [];

  client.on("item_started", (p) => started.push(p));
  client.on("item_completed", (p) => completed.push(p));

  // Simulate notification without id
  client._handleNotification({
    method: "item/started",
    params: { item: { type: "tool_call", name: "worker_explore", arguments: { task: "find files" } } },
  });

  client._handleNotification({
    method: "item/completed",
    params: { item: { type: "tool_call", name: "worker_explore" } },
  });

  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.ok(started[0].item.id, "item_started must carry a truthy item.id");
  assert.equal(started[0].item.id, completed[0].item.id, "start and completed ids must match");
});

test("CodexAppClient handles concurrent tool calls without ID collisions", () => {
  const client = new CodexAppClient();
  const started = [];
  const completed = [];

  client.on("item_started", (p) => started.push(p));
  client.on("item_completed", (p) => completed.push(p));

  // Simulate two concurrent tool calls starting before either finishes
  client._handleNotification({
    method: "item/started",
    params: { item: { type: "tool_call", name: "worker_explore", arguments: { task: "task 1" } } },
  });
  client._handleNotification({
    method: "item/started",
    params: { item: { type: "tool_call", name: "worker_implement", arguments: { task: "task 2" } } },
  });

  assert.equal(started.length, 2);
  const id1 = started[0].item.id;
  const id2 = started[1].item.id;
  assert.notEqual(id1, id2, "Concurrent tool calls must have distinct IDs");

  // Complete second tool first
  client._handleNotification({
    method: "item/completed",
    params: { item: { type: "tool_call", name: "worker_implement" } },
  });
  // Complete first tool second
  client._handleNotification({
    method: "item/completed",
    params: { item: { type: "tool_call", name: "worker_explore" } },
  });

  assert.equal(completed.length, 2);
  assert.equal(completed[0].item.id, id2);
  assert.equal(completed[1].item.id, id1);
});

test("CodexAppClient correctly matches out-of-order completions for identical tool names by task signature", () => {
  const client = new CodexAppClient();
  const started = [];
  const completed = [];

  client.on("item_started", (p) => started.push(p));
  client.on("item_completed", (p) => completed.push(p));

  // Two concurrent calls of the EXACT SAME tool name
  client._handleNotification({
    method: "item/started",
    params: { item: { type: "tool_call", name: "worker_explore", arguments: { task: "explore auth flow" } } },
  });
  client._handleNotification({
    method: "item/started",
    params: { item: { type: "tool_call", name: "worker_explore", arguments: { task: "explore database schema" } } },
  });

  assert.equal(started.length, 2);
  const id1 = started[0].item.id;
  const id2 = started[1].item.id;
  assert.notEqual(id1, id2, "Must assign distinct IDs");

  // Out-of-order completion: second tool finishes first!
  client._handleNotification({
    method: "item/completed",
    params: { item: { type: "tool_call", name: "worker_explore", arguments: { task: "explore database schema" } } },
  });
  // First tool finishes second
  client._handleNotification({
    method: "item/completed",
    params: { item: { type: "tool_call", name: "worker_explore", arguments: { task: "explore auth flow" } } },
  });

  assert.equal(completed.length, 2);
  assert.equal(completed[0].item.id, id2, "First completion must match the second call (database schema)");
  assert.equal(completed[1].item.id, id1, "Second completion must match the first call (auth flow)");
});

