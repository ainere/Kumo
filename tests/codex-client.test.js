/**
 * codex-client.test.js — Verification tests for CodexAppClient JSON-RPC protocol.
 */

import { test } from "node:test";
import assert from "node:assert";
import { CodexAppClient } from "../src/providers/orchestrators/codex-client.js";
import { findCodexBinary } from "../src/providers/orchestrators/codex.js";

test("findCodexBinary locates executable", () => {
  const bin = findCodexBinary();
  assert.ok(bin && bin.length > 0);
});

test("CodexAppClient initializes and retrieves live account rate limits", async () => {
  const client = new CodexAppClient();
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
