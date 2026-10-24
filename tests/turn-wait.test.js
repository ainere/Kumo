import "./helpers/env.js";
/**
 * turn-wait.test.js — Terminal-state detection for an orchestrator turn.
 *
 * The REPL used to await only `turn_completed`; later it raced the three
 * terminal events but attached its listeners only after `startTurn` resolved,
 * and treated a `startTurn` return value of `{ ok }` as the end of the turn.
 * These tests pin `runTurn`, which fixes all three, against fake clients and
 * against the real Antigravity client whose early return exposed the bug.
 */

import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { runTurn } from "../src/providers/orchestrators/turn-wait.js";
import { AgyAppClient } from "../src/providers/orchestrators/agy-client.js";

/** A client double: an EventEmitter with a recording interruptTurn. */
function fakeClient() {
  const client = new EventEmitter();
  client.interrupts = 0;
  client.interruptTurn = async () => {
    client.interrupts++;
  };
  return client;
}

/** Resolve after `ms`, so tests can check that something has NOT happened yet. */
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Report whether a promise has settled, without waiting for it. */
async function isSettled(promise) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  await tick(0);
  return settled;
}

test("turn_completed without a payload resolves the turn as successful", async () => {
  const client = fakeClient();
  const turn = runTurn(client, () => setTimeout(() => client.emit("turn_completed"), 5), { timeoutMs: 5000 });
  assert.deepStrictEqual(await turn.done, { ok: true });
});

test("a turn_completed payload with ok:false is a failed turn", async () => {
  const client = fakeClient();
  const turn = runTurn(
    client,
    () => setTimeout(() => client.emit("turn_completed", { ok: false, reason: "turn failed: quota" }), 5),
    { timeoutMs: 5000 }
  );
  assert.deepStrictEqual(await turn.done, { ok: false, reason: "turn failed: quota" });
});

test("server_error settles the turn instead of hanging it", async () => {
  const client = fakeClient();
  const turn = runTurn(client, () => setTimeout(() => client.emit("server_error", new Error("stream aborted")), 5), {
    timeoutMs: 5000,
  });
  const outcome = await turn.done;
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.reason, /stream aborted/);
});

test("a server_error also stops the orchestrator before the next prompt can start", async () => {
  // Otherwise the REPL accepts a new prompt while the orchestrator is still
  // working on this one, and the two turns interleave.
  const client = fakeClient();
  const turn = runTurn(client, () => setTimeout(() => client.emit("server_error", new Error("stream reset")), 5), {
    timeoutMs: 5000,
  });
  await turn.done;
  await tick();
  assert.strictEqual(client.interrupts, 1);
});

test("a child exit settles the turn and reports the exit code", async () => {
  const client = fakeClient();
  const turn = runTurn(client, () => setTimeout(() => client.emit("close", 137), 5), { timeoutMs: 5000 });
  const outcome = await turn.done;
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.reason, /137/);
});

test("a completion emitted while the turn is being submitted is not missed", async () => {
  // Codex can deliver turn/completed in the same stdout chunk as the turn/start
  // response — before startTurn's promise resolves. A listener attached after
  // startTurn would miss it and wait out the whole timeout.
  const client = fakeClient();
  const turn = runTurn(
    client,
    async () => {
      client.emit("turn_completed", { ok: true });
      return { turnId: "t1" };
    },
    { timeoutMs: 200 }
  );
  assert.deepStrictEqual(await turn.done, { ok: true });
});

test("startTurn returning {ok:true} does not end the turn", async () => {
  // The old helper treated this return value as the outcome, so a client that
  // returns on submission (Antigravity) "finished" before doing anything.
  const client = fakeClient();
  const turn = runTurn(client, async () => ({ ok: true }), { timeoutMs: 5000 });
  assert.strictEqual(await isSettled(turn.done), false, "the turn must still be running");
  client.emit("turn_completed", { ok: true });
  assert.deepStrictEqual(await turn.done, { ok: true });
});

test("the real Antigravity client's turn lasts until its result event", async () => {
  const client = new AgyAppClient({ bin: "agy-not-spawned" });
  const written = [];
  // A stand-in for the running agy process: startTurn only writes to stdin.
  client.proc = { killed: false, stdin: { write: (line) => written.push(line) } };

  const turn = runTurn(client, () => client.startTurn("explore the repo"), { timeoutMs: 5000 });
  await tick();

  assert.strictEqual(written.length, 1, "the prompt was submitted");
  assert.strictEqual(await isSettled(turn.done), false, "submission is not completion");

  client._handleStreamEvent({ event: "result", result: { status: "OK" } });
  assert.deepStrictEqual(await turn.done, { ok: true });
});

test("an Antigravity result with status ERROR fails the turn with its message", async () => {
  const client = new AgyAppClient({ bin: "agy-not-spawned" });
  client.proc = { killed: false, stdin: { write: () => {} } };
  const turn = runTurn(client, () => client.startTurn("x"), { timeoutMs: 5000 });
  await tick();
  client._handleStreamEvent({ event: "result", result: { status: "ERROR", error: "invalid model selection" } });
  assert.deepStrictEqual(await turn.done, { ok: false, reason: "invalid model selection" });
});

test("a timeout interrupts the orchestrator and reports the turn as timed out", async () => {
  const client = fakeClient();
  client.interruptTurn = async () => {
    client.interrupts++;
    client.emit("turn_completed", { ok: false, reason: "interrupted" });
  };
  const turn = runTurn(client, async () => ({}), { timeoutMs: 30, graceMs: 1000 });
  const outcome = await turn.done;
  assert.strictEqual(client.interrupts, 1, "the timed-out turn must be stopped, not abandoned");
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.timedOut, true);
  assert.match(outcome.reason, /timed out/i);
});

test("interrupt() stops the turn and the outcome says it was interrupted", async () => {
  const client = fakeClient();
  client.interruptTurn = async () => {
    client.interrupts++;
    setTimeout(() => client.emit("turn_completed", { ok: false, reason: "interrupted" }), 5);
  };
  const turn = runTurn(client, async () => ({}), { timeoutMs: 5000 });
  await tick();
  turn.interrupt();
  const outcome = await turn.done;
  assert.strictEqual(client.interrupts, 1);
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.interrupted, true);
});

test("interrupt() settles even when the client never confirms", async () => {
  const client = fakeClient(); // interruptTurn emits nothing
  const turn = runTurn(client, async () => ({}), { timeoutMs: 5000, graceMs: 30 });
  await tick();
  turn.interrupt();
  const outcome = await turn.done;
  assert.strictEqual(outcome.interrupted, true);
});

test("a startTurn that throws ends the turn with its error", async () => {
  const client = fakeClient();
  const turn = runTurn(
    client,
    async () => {
      throw new Error("Codex app-server is not running");
    },
    { timeoutMs: 5000 }
  );
  assert.deepStrictEqual(await turn.done, { ok: false, reason: "Codex app-server is not running" });
});

test("every listener is removed once the turn settles", async () => {
  const client = fakeClient();
  const turn = runTurn(client, async () => ({}), { timeoutMs: 5000 });

  assert.strictEqual(client.listenerCount("turn_completed"), 1);
  assert.strictEqual(client.listenerCount("server_error"), 1);
  assert.strictEqual(client.listenerCount("close"), 1);

  client.emit("turn_completed");
  await turn.done;

  // Leaked listeners would accumulate one set per turn for the whole session.
  assert.strictEqual(client.listenerCount("turn_completed"), 0);
  assert.strictEqual(client.listenerCount("server_error"), 0);
  assert.strictEqual(client.listenerCount("close"), 0);
});

test("only the first terminal event decides the outcome", async () => {
  const client = fakeClient();
  const turn = runTurn(client, async () => ({}), { timeoutMs: 5000 });
  await tick(0);

  client.emit("turn_completed");
  client.emit("server_error", new Error("late failure"));
  client.emit("close", 1);

  assert.deepStrictEqual(await turn.done, { ok: true });
});
