import "./helpers/env.js";
/**
 * orchestrator-clients.test.js — Per-turn CLI orchestrators, run against stub binaries.
 *
 * The Claude client used to run `claude -p <prompt>` with nothing else: no MCP
 * config (so it could never reach the worker tools), no permission to call
 * them headlessly, and no session, so each turn forgot the last. These tests
 * check the command line it now builds and that every client family reports
 * the end of a turn — success, failure, interruption — the same way.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn } from "../src/providers/orchestrators/turn-wait.js";
import { ClaudeAppClient, BRIDGE_TOOL_RULE } from "../src/providers/orchestrators/claude-client.js";
import { GenericAppClient } from "../src/providers/orchestrators/generic-client.js";
import { BRIDGE_SERVER_PATH } from "../src/config/sync.js";
import { OpenAIApiClient } from "../src/providers/api/openai-api-client.js";

/**
 * Write a stub CLI that logs `{ args, stdin }` per call to `log`, then runs `tail`.
 */
function writeStub(dir, log, tail = 'process.stdout.write("ok");') {
  const impl = path.join(dir, "cli.cjs");
  fs.writeFileSync(
    impl,
    `const fs = require("fs");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf-8"); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin }) + "\\n");
${tail}`
  );
  if (process.platform === "win32") {
    const stub = path.join(dir, "cli.cmd");
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
    return stub;
  }
  const stub = path.join(dir, "cli.sh");
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  return stub;
}

const readCalls = (log) =>
  fs
    .readFileSync(log, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("the Claude orchestrator gets the bridge, may call it, and keeps one conversation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const client = new ClaudeAppClient({ bin: writeStub(dir, log), workspace: dir, model: "claude-opus-4-6" });
  try {
    await client.start();
    await client.startThread({ workspace: dir });
    assert.deepStrictEqual(await runTurn(client, () => client.startTurn("first\nmulti-line prompt")).done, { ok: true });
    const mcpConfigFile = client.mcpConfigPath;
    assert.deepStrictEqual(await runTurn(client, () => client.startTurn("second")).done, { ok: true });

    const [first, second] = readCalls(log);
    assert.strictEqual(valueAfter(first.args, "--allowedTools"), BRIDGE_TOOL_RULE, "print mode denies unlisted tools");
    assert.strictEqual(first.stdin, "first\nmulti-line prompt", "the prompt travels over stdin, newlines intact");

    const config = JSON.parse(fs.readFileSync(valueAfter(first.args, "--mcp-config"), "utf-8"));
    const bridge = config.mcpServers["kumo-bridge"];
    assert.deepStrictEqual(bridge.args, [BRIDGE_SERVER_PATH, "--workspace", dir]);

    const sessionId = valueAfter(first.args, "--session-id");
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.strictEqual(valueAfter(second.args, "--resume"), sessionId, "the second turn continues the first");
    assert.strictEqual(valueAfter(second.args, "--model"), "claude-opus-4-6");

    await client.stop();
    assert.strictEqual(fs.existsSync(mcpConfigFile), false, "the per-session MCP config is cleaned up");
  } finally {
    await client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a new thread starts a new Claude conversation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const client = new ClaudeAppClient({ bin: writeStub(dir, log), workspace: dir });
  try {
    await client.startThread({ workspace: dir });
    await runTurn(client, () => client.startTurn("a")).done;
    await client.startThread({ workspace: dir });
    await runTurn(client, () => client.startTurn("b")).done;
    const [a, b] = readCalls(log);
    assert.ok(b.args.includes("--session-id"), "after /new the conversation must not be resumed");
    assert.notStrictEqual(valueAfter(a.args, "--session-id"), valueAfter(b.args, "--session-id"));
  } finally {
    await client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI that exits non-zero fails the turn with its exit code and stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-generic-"));
  const log = path.join(dir, "calls.jsonl");
  const bin = writeStub(dir, log, 'process.stderr.write("quota exhausted"); process.exit(2);');
  const client = new GenericAppClient({ command: "some-cli", bin, workspace: dir });
  try {
    const outcome = await runTurn(client, () => client.startTurn("do it")).done;
    assert.strictEqual(outcome.ok, false);
    assert.match(outcome.reason, /exited with code 2: quota exhausted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an API answer that arrives after Ctrl+C does not complete the next turn", async () => {
  // The HTTP request cannot be cancelled, so it used to finish after the
  // interrupt and emit a bare turn_completed — which the *next* turn took as
  // its own successful completion, saving the old answer.
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  let release;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      release = () =>
        resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "OLD ANSWER" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
    });
  const client = new OpenAIApiClient({ model: "m", config: {} });
  const deltas = [];
  client.on("delta", (d) => deltas.push(d));
  try {
    const first = runTurn(client, () => client.startTurn("first"), { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 20));
    first.interrupt();
    assert.strictEqual((await first.done).interrupted, true);

    // The next turn is waiting when the old request finally returns.
    const second = runTurn(client, () => new Promise(() => {}), { timeoutMs: 300, graceMs: 50 });
    release();
    const outcome = await second.done;
    assert.notStrictEqual(outcome.ok, true, "the stale answer must not complete the next turn");
    assert.deepStrictEqual(deltas, [], "the stale answer must not be shown or saved");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
});

test("interrupting a per-turn CLI stops its process and ends the turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-generic-"));
  const log = path.join(dir, "calls.jsonl");
  const bin = writeStub(dir, log, "setTimeout(() => {}, 60000);");
  const client = new GenericAppClient({ command: "slow-cli", bin, workspace: dir });
  try {
    const turn = runTurn(client, () => client.startTurn("long task"), { timeoutMs: 30000 });
    for (let i = 0; i < 50 && !client.proc; i++) await new Promise((r) => setTimeout(r, 20));
    const proc = client.proc;
    assert.ok(proc, "the turn's process should be running");
    turn.interrupt();
    const outcome = await turn.done;
    assert.strictEqual(outcome.interrupted, true);
    await new Promise((resolve) => (proc.exitCode !== null || proc.signalCode !== null ? resolve() : proc.on("close", resolve)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
