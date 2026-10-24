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
import { fileURLToPath } from "node:url";

/** A real `claude -p --output-format stream-json` turn (Claude Code 2.1.307) that calls worker_explore once. */
const CLAUDE_STREAM = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-stream.jsonl");
// Like the real CLI, the stub reports the session id it was given.
const FIXTURE_SESSION = "3fb8861e-7d8e-4f1b-8e35-cbd341b26a92";
const echoSession = `const a = process.argv.slice(2); const at = a.findIndex((x) => x === "--session-id" || x === "--resume"); const sid = at >= 0 ? a[at + 1] : ${JSON.stringify(FIXTURE_SESSION)};
`;
const printClaudeStream = echoSession + `process.stdout.write(fs.readFileSync(${JSON.stringify(CLAUDE_STREAM)}, "utf-8").split(${JSON.stringify(FIXTURE_SESSION)}).join(sid));`;

/** The fixture with its events changed by `patch`, as a stub tail. */
function printPatchedClaudeStream(patch) {
  const lines = fs.readFileSync(CLAUDE_STREAM, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  patch(lines);
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return `process.stdout.write(${JSON.stringify(text)});`;
}

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
  const client = new ClaudeAppClient({
    bin: writeStub(dir, log, printClaudeStream),
    workspace: dir,
    model: "claude-opus-5-5",
    effort: "high",
  });
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
    assert.strictEqual(valueAfter(second.args, "--model"), "claude-opus-5-5");
    assert.strictEqual(valueAfter(second.args, "--effort"), "high");
    assert.strictEqual(valueAfter(first.args, "--output-format"), "stream-json");
    assert.ok(first.args.includes("--strict-mcp-config"), "only the bridge is started, not the user's other servers");

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
  const client = new ClaudeAppClient({ bin: writeStub(dir, log, printClaudeStream), workspace: dir });
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

test("Claude's stream yields its answer, the worker call, and the account's rate limits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const client = new ClaudeAppClient({ bin: writeStub(dir, log, printClaudeStream), workspace: dir });
  const deltas = [];
  const started = [];
  const completed = [];
  client.on("delta", (t) => deltas.push(t));
  client.on("item_started", (p) => started.push(p.item));
  client.on("item_completed", (p) => completed.push(p.item));
  try {
    await client.startThread({ workspace: dir });
    assert.deepStrictEqual(await runTurn(client, () => client.startTurn("where is add?")).done, { ok: true });

    assert.strictEqual(deltas.join(""), "`add` is defined at `src\\math.js:1` as `export function add(a, b)`.");
    assert.ok(deltas.length > 1, "the answer streams in pieces, not as one block at the end");

    const worker = started.filter((i) => i.type === "mcpToolCall");
    assert.strictEqual(worker.length, 1);
    assert.strictEqual(worker[0].server, "kumo-bridge");
    assert.strictEqual(worker[0].tool, "worker_explore");
    assert.match(worker[0].arguments.task, /function `add`/);
    assert.ok(started.some((i) => i.type === "toolUse" && i.name === "ToolSearch"), "built-in tools are not worker calls");
    assert.deepStrictEqual(
      completed.filter((i) => i.type === "mcpToolCall").map((i) => [i.id, i.status]),
      [[worker[0].id, "completed"]]
    );

    // five_hour is 14% used, seven_day 15%: the tighter window is reported.
    const limits = await client.getRateLimits();
    assert.strictEqual(limits.remainingPercent, 85);
    assert.strictEqual(limits.windowMinutes, 10080);
    assert.match(client.currentThreadId(), /^[0-9a-f-]{36}$/, "a finished turn leaves a conversation to resume");
  } finally {
    await client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Claude error result fails the turn with Claude's own reason", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const tail = printPatchedClaudeStream((lines) => {
    lines.splice(1, lines.length - 2);
    Object.assign(lines.at(-1), { subtype: "error_during_execution", is_error: true, result: "Usage limit reached" });
  });
  const client = new ClaudeAppClient({ bin: writeStub(dir, log, tail), workspace: dir });
  try {
    await client.startThread({ workspace: dir });
    const outcome = await runTurn(client, () => client.startTurn("hi")).done;
    assert.deepStrictEqual(outcome, { ok: false, reason: "Usage limit reached" });
    assert.strictEqual(client.currentThreadId(), null, "a failed first turn leaves nothing to resume");
  } finally {
    await client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude Code runs on the subscription login: API keys are withheld, and a key in use is reported", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const envLog = path.join(dir, "env.txt");
  const tail =
    `fs.writeFileSync(${JSON.stringify(envLog)}, [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN].map(Boolean).join(","));\n` +
    printPatchedClaudeStream((lines) => {
      lines[0].apiKeySource = "apiKeyHelper";
      lines[0].mcp_servers = [{ name: "kumo-bridge", status: "failed" }];
    });
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ANTHROPIC_AUTH_TOKEN = "tok-test";
  const client = new ClaudeAppClient({ bin: writeStub(dir, log, tail), workspace: dir });
  const warnings = [];
  client.on("warning", (w) => warnings.push(w.message));
  try {
    await client.startThread({ workspace: dir });
    await runTurn(client, () => client.startTurn("hi")).done;
    assert.strictEqual(fs.readFileSync(envLog, "utf-8"), "false,false");
    assert.ok(warnings.some((m) => /using an API key \(apiKeyHelper\)/.test(m)), warnings.join("\n"));
    assert.ok(warnings.some((m) => /kumo-bridge failed/.test(m)), warnings.join("\n"));
  } finally {
    for (const [name, value] of [
      ["ANTHROPIC_API_KEY", saved.key],
      ["ANTHROPIC_AUTH_TOKEN", saved.token],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await client.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resuming a Claude conversation continues it on the next turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-claude-"));
  const log = path.join(dir, "calls.jsonl");
  const client = new ClaudeAppClient({ bin: writeStub(dir, log, printClaudeStream), workspace: dir });
  try {
    await client.resumeThread({ threadId: "3fb8861e-7d8e-4f1b-8e35-cbd341b26a92", workspace: dir });
    await runTurn(client, () => client.startTurn("and sub?")).done;
    const [call] = readCalls(log);
    assert.strictEqual(valueAfter(call.args, "--resume"), "3fb8861e-7d8e-4f1b-8e35-cbd341b26a92");
    assert.ok(!call.args.includes("--session-id"));
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

test("Antigravity reopens a conversation by id, keeps it across a model switch, and /new starts a fresh one", async () => {
  const { AgyAppClient } = await import("../src/providers/orchestrators/agy-client.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-agy-"));
  const log = path.join(dir, "launches.jsonl");
  const impl = path.join(dir, "agy.cjs");
  // Like agy in stream-json mode: stays up reading stdin.
  fs.writeFileSync(impl, `require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n"); process.stdin.resume();`);
  let bin;
  if (process.platform === "win32") {
    bin = path.join(dir, "agy.cmd");
    fs.writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
  } else {
    bin = path.join(dir, "agy.sh");
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  }
  const launches = () => fs.readFileSync(log, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const client = new AgyAppClient({ bin, workspace: dir, model: "gemini-3.8-flash", safetyMode: "autonomous" });
  try {
    await client.resumeThread({ threadId: "conv-42", workspace: dir });
    assert.strictEqual(valueAfter(launches().at(-1), "--conversation"), "conv-42");
    assert.strictEqual(client.currentThreadId(), "conv-42");

    await client.applyModel({ model: "gemini-4-argon" });
    assert.strictEqual(valueAfter(launches().at(-1), "--model"), "gemini-4-argon");
    assert.strictEqual(valueAfter(launches().at(-1), "--conversation"), "conv-42", "a model switch keeps the conversation");

    await client.startThread({ workspace: dir });
    assert.ok(!launches().at(-1).includes("--conversation"), "a new thread is a new conversation");
    assert.strictEqual(client.currentThreadId(), null);
  } finally {
    await client.stop();
    await new Promise((r) => setTimeout(r, 100));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
