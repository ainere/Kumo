import "./helpers/env.js";
/**
 * run-command.test.js — `kumo run` drives a client through a whole turn.
 *
 * `runCommand` never called `client.start()`, so with the default Codex
 * orchestrator every run failed with "app-server is not running"; nothing
 * tested it. These tests use fake clients that enforce the same contract the
 * real ones have: start() before any request, and a turn that ends on an event.
 */

import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { runCommand } from "../src/commands/run.js";

/**
 * A client that, like CodexAppClient, rejects requests until start() ran.
 *
 * @param {{ finish?: (client: EventEmitter) => void, submitOnly?: boolean }} [behavior]
 */
function fakeClient({ finish, submitOnly = false } = {}) {
  const client = new EventEmitter();
  client.calls = [];
  client.started = false;
  client.start = async () => {
    client.calls.push("start");
    client.started = true;
  };
  client.startThread = async () => {
    client.calls.push("startThread");
    if (!client.started) throw new Error("Codex app-server is not running or stdin is closed.");
  };
  client.startTurn = async (prompt) => {
    client.calls.push(`startTurn:${prompt}`);
    if (!client.started) throw new Error("Codex app-server is not running or stdin is closed.");
    setTimeout(() => (finish ? finish(client) : client.emit("turn_completed", { ok: true })), 20);
    return submitOnly ? { submitted: true } : { turnId: "t1" };
  };
  client.interruptTurn = async () => client.calls.push("interrupt");
  client.stop = async () => client.calls.push("stop");
  return client;
}

/** Run `kumo run` against a fake client and capture the exit code. */
async function run(client, prompt = "summarize the repo") {
  let exitCode = null;
  await runCommand(prompt, { dir: process.cwd() }, { createClient: () => client, exit: (c) => (exitCode = c) });
  return exitCode;
}

test("kumo run starts the client before talking to it, and exits 0 on success", async () => {
  const client = fakeClient();
  const code = await run(client);
  assert.strictEqual(code, 0);
  assert.deepStrictEqual(client.calls, ["start", "startThread", "startTurn:summarize the repo", "stop"]);
});

test("kumo run waits for a client that returns as soon as the prompt is written", async () => {
  // Antigravity's startTurn resolves on submission; stopping the client right
  // after it killed the turn before any output.
  const client = fakeClient({ submitOnly: true });
  const code = await run(client);
  assert.strictEqual(code, 0);
  assert.strictEqual(client.calls.at(-1), "stop", "stop only after the turn completed");
});

test("kumo run exits 1 when the turn fails", async () => {
  const client = fakeClient({ finish: (c) => c.emit("turn_completed", { ok: false, reason: "usage limit" }) });
  assert.strictEqual(await run(client), 1);
});

test("kumo run declines approval requests instead of stalling the turn", async () => {
  const declined = [];
  const client = fakeClient({
    finish: (c) => {
      c.emit("server_request", {
        isApproval: true,
        description: "Command: rm -rf build",
        decline: () => declined.push("rm"),
        approve: () => assert.fail("a headless run must never approve"),
      });
      c.emit("turn_completed", { ok: true });
    },
  });
  assert.strictEqual(await run(client), 0);
  assert.deepStrictEqual(declined, ["rm"]);
});

test("-d after a subcommand reaches that subcommand", async () => {
  // The root command defines -d too; commander let it claim the option, so
  // `kumo run "…" -d <path>` ran in the current directory instead.
  const { createCli } = await import("../src/cli.js");
  const cases = {
    run: ["run", "hi", "-d", "/work/a"],
    status: ["status", "-d", "/work/a"],
    graph: ["graph", "-d", "/work/a"],
    init: ["init", "-d", "/work/a"],
  };
  for (const [name, argv] of Object.entries(cases)) {
    const cli = createCli();
    let dir;
    // commander passes the command object as the action's last argument.
    cli.commands.find((c) => c.name() === name).action((...args) => {
      dir = args.at(-1).opts().dir;
    });
    await cli.parseAsync(["node", "kumo", ...argv]);
    assert.strictEqual(dir, "/work/a", `kumo ${name} -d`);
  }
});

test("kumo run rejects an empty prompt", async () => {
  const client = fakeClient();
  assert.strictEqual(await run(client, "   "), 1);
  assert.deepStrictEqual(client.calls, []);
});
