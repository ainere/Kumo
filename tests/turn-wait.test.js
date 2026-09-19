import "./helpers/env.js";
/**
 * turn-wait.test.js — Terminal-state detection for an orchestrator turn.
 *
 * The REPL used to await only `turn_completed`. A `server_error` then left the
 * turn promise pending forever, `isTurnActive` stuck true, and every later
 * prompt silently discarded. These tests pin the three terminal paths and the
 * listener cleanup that makes repeated turns safe.
 */

import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { awaitTurnCompletion } from "../src/providers/orchestrators/turn-wait.js";

test("turn_completed resolves the turn as successful", async () => {
  const client = new EventEmitter();
  const pending = awaitTurnCompletion(client, { timeoutMs: 5000 });
  client.emit("turn_completed");
  assert.deepStrictEqual(await pending, { ok: true });
});

test("server_error settles the turn instead of hanging it", async () => {
  const client = new EventEmitter();
  const pending = awaitTurnCompletion(client, { timeoutMs: 5000 });
  client.emit("server_error", new Error("stream aborted"));

  const outcome = await pending;
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.reason, /stream aborted/);
});

test("a child exit settles the turn and reports the exit code", async () => {
  const client = new EventEmitter();
  const pending = awaitTurnCompletion(client, { timeoutMs: 5000 });
  client.emit("close", 137);

  const outcome = await pending;
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.reason, /137/);
});

test("the turn times out rather than waiting forever on a silent client", async () => {
  const client = new EventEmitter();
  await assert.rejects(awaitTurnCompletion(client, { timeoutMs: 30 }), /timed out/i);
});

test("every listener is removed once the turn settles", async () => {
  const client = new EventEmitter();
  const pending = awaitTurnCompletion(client, { timeoutMs: 5000 });

  assert.strictEqual(client.listenerCount("turn_completed"), 1);
  assert.strictEqual(client.listenerCount("server_error"), 1);
  assert.strictEqual(client.listenerCount("close"), 1);

  client.emit("turn_completed");
  await pending;

  // Leaked listeners would accumulate one set per turn for the whole session.
  assert.strictEqual(client.listenerCount("turn_completed"), 0);
  assert.strictEqual(client.listenerCount("server_error"), 0);
  assert.strictEqual(client.listenerCount("close"), 0);
});

test("only the first terminal event decides the outcome", async () => {
  const client = new EventEmitter();
  const pending = awaitTurnCompletion(client, { timeoutMs: 5000 });

  client.emit("turn_completed");
  client.emit("server_error", new Error("late failure"));
  client.emit("close", 1);

  assert.deepStrictEqual(await pending, { ok: true });
});

test("a client that reports its outcome synchronously is not waited on twice", async () => {
  // GenericAppClient.startTurn resolves { ok } itself and emits turn_completed
  // before awaitTurnCompletion could ever attach; treating that as terminal is
  // what keeps `kumo run` working for those providers.
  const client = new EventEmitter();

  assert.deepStrictEqual(
    await awaitTurnCompletion(client, { timeoutMs: 5000, startTurnResult: { ok: true } }),
    { ok: true }
  );

  const failed = await awaitTurnCompletion(client, {
    timeoutMs: 5000,
    startTurnResult: { ok: false, reason: "exit 2" },
  });
  assert.strictEqual(failed.ok, false);
  assert.match(failed.reason, /exit 2/);

  assert.strictEqual(client.listenerCount("turn_completed"), 0, "no listeners are attached at all");
});
