import "./helpers/env.js";
/**
 * bridge-tools.test.js — End-to-end MCP coverage for the worker tools.
 *
 * Everything here goes through a real `callTool` over stdio, because the
 * diff-review protocol and the provider allowlist are properties of the wire
 * contract, not of the helper functions they are built from. The worker is a
 * stub binary wired in through `CODEX_BIN` / `OLLAMA_BIN`, so no provider CLI
 * is required.
 *
 * The stub records every invocation (argv + stdin) to a JSON-lines log. The
 * permission a worker was launched with is the actual safety guarantee, so the
 * tests assert on those flags — "the workspace is unchanged" alone proves
 * nothing when the stub never writes.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../src/bridge/server.js");

/** A preview diff that applies cleanly to the fixture's target.txt. */
const GOOD_DIFF = ["--- a/target.txt", "+++ b/target.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

/** A preview diff whose context does not match target.txt, so git apply refuses it. */
const STALE_DIFF = ["--- a/target.txt", "+++ b/target.txt", "@@ -1 +1 @@", "-missing", "+new", ""].join("\n");

/**
 * Build a throwaway git workspace plus a stub worker binary.
 *
 * In preview mode the stub prints `preview` (wrapped in prose and a ```diff
 * fence, as real workers do). Otherwise it follows `apply`: "fail" exits 3,
 * "write" replaces target.txt with "new" and exits 0.
 *
 * @param {{ preview?: string, apply?: "fail"|"write", reply?: string }} [behavior]
 */
function makeFixture({ preview = GOOD_DIFF, apply = "fail", reply = "stub reply", quiet = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-mcp-"));
  const callLog = path.join(dir, "calls.jsonl");
  fs.writeFileSync(path.join(dir, "target.txt"), "old\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "calls.jsonl\nstub-impl.cjs\n*-stub.*\n");
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
    cwd: dir,
    stdio: "ignore",
  });

  const impl = path.join(dir, "stub-impl.cjs");
  fs.writeFileSync(
    impl,
    `const fs = require("fs");
const path = require("path");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf-8"); } catch {}
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args, stdin }) + "\\n");
if (${JSON.stringify(quiet)}) {
  // Like headless agy when a needed permission is denied: exit 0, explain on stderr.
  process.stderr.write("no output produced: a tool required a permission headless mode cannot grant");
  process.exit(0);
}
const text = args.join(" ") + stdin;
if (text.includes("DIFF PREVIEW MODE")) {
  process.stdout.write("Proposed change:\\n\`\`\`diff\\n" + ${JSON.stringify(preview)} + "\`\`\`\\nImpact: one line.");
  process.exit(0);
}
if (text.includes("worker_implement") || text.includes("[Task]")) {
  if (${JSON.stringify(apply)} === "write" && /implement|apply|replace/i.test(text)) {
    fs.writeFileSync(path.join(process.cwd(), "target.txt"), "new\\n");
    process.stdout.write("wrote target.txt");
    process.exit(0);
  }
}
if (/replace old with new|apply the diff/.test(text)) {
  process.stderr.write("stub apply failure");
  process.exit(3);
}
process.stdout.write(${JSON.stringify(reply)});
`
  );

  let stub;
  if (process.platform === "win32") {
    stub = path.join(dir, "worker-stub.cmd");
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
  } else {
    stub = path.join(dir, "worker-stub.sh");
    fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  }

  const calls = () =>
    fs.existsSync(callLog)
      ? fs
          .readFileSync(callLog, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return { dir, stub, calls };
}

/**
 * Connect to a bridge server bound to `dir`, run `fn(client)`, then tear down.
 */
async function withBridge({ dir, stub, safetyMode, extraEnv = {}, home: givenHome }, fn) {
  const home = givenHome || fs.mkdtempSync(path.join(os.tmpdir(), "kumo-mcp-home-"));
  const args = [serverPath, "--workspace", dir];
  if (safetyMode) args.push("--safety-mode", safetyMode);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: dir,
    env: {
      ...process.env,
      KUMO_HOME: home,
      KUMO_NO_SYNC: "1",
      KUMO_WORKER_PROVIDER: "codex",
      CODEX_BIN: stub,
      OLLAMA_BIN: stub,
      ...extraEnv,
    },
  });

  const client = new Client({ name: "bridge-tools-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await transport.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const readText = (p) => fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n");
const textOf = (res) => (res?.content || []).map((c) => c.text || "").join("\n");
const previewIdOf = (res) => textOf(res).match(/Preview ID: "([^"]+)"/)?.[1];

/** The value following `--sandbox` in a recorded Codex invocation. */
const sandboxOf = (call) => call.args[call.args.indexOf("--sandbox") + 1];

test("an unknown worker provider is rejected before dispatch, not by a failed spawn", async () => {
  const { dir, stub, calls } = makeFixture();

  try {
    const res = await withBridge({ dir, stub }, (client) =>
      client.callTool({
        name: "worker_explore",
        arguments: { task: "list files", provider: "definitely-not-a-provider" },
      })
    );

    const text = textOf(res);
    assert.strictEqual(res.isError, true, `expected an error result, got: ${text}`);
    // Distinguishes an allowlist refusal from an ENOENT: before the fix the id
    // was accepted and became the name of the executable to spawn, which also
    // produced an error result — just for the wrong reason.
    assert.match(text, /definitely-not-a-provider/);
    assert.match(
      text,
      /anthropic-api/,
      "the refusal must enumerate the known providers rather than report a spawn failure"
    );
    assert.doesNotMatch(text, /ENOENT|Failed to spawn/);
    assert.strictEqual(calls().length, 0, "no worker process may be spawned for an unknown provider");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("read-only tools launch the Codex worker in its read-only sandbox", async () => {
  const { dir, stub, calls } = makeFixture();
  try {
    await withBridge({ dir, stub }, (client) =>
      client.callTool({ name: "worker_explore", arguments: { task: "map the repo" } })
    );
    const [call] = calls();
    assert.ok(call, "the worker must have run");
    assert.strictEqual(sandboxOf(call), "read-only");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("diff-review phase 1 previews in the read-only sandbox without touching the workspace", async () => {
  const { dir, stub, calls } = makeFixture();
  const before = fs.readFileSync(path.join(dir, "target.txt"), "utf-8");

  try {
    const res = await withBridge({ dir, stub, safetyMode: "diff-review" }, (client) =>
      client.callTool({ name: "worker_implement", arguments: { task: "replace old with new" } })
    );

    const text = textOf(res);
    assert.match(text, /\[STATUS: PENDING_CONFIRMATION\]/);
    assert.match(text, /Preview ID: "prev_[0-9a-f-]+"/);
    // The guarantee is the permission the worker got, not the stub's manners.
    assert.strictEqual(sandboxOf(calls()[0]), "read-only");
    assert.strictEqual(fs.readFileSync(path.join(dir, "target.txt"), "utf-8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an approved diff-review preview is applied exactly, without re-running the worker", async () => {
  const { dir, stub, calls } = makeFixture({ preview: GOOD_DIFF });

  try {
    const text = await withBridge({ dir, stub, safetyMode: "diff-review" }, async (client) => {
      const phase1 = await client.callTool({ name: "worker_implement", arguments: { task: "replace old with new" } });
      const previewId = previewIdOf(phase1);
      assert.ok(previewId, "phase 1 must return a preview id");
      const phase2 = await client.callTool({
        name: "worker_implement",
        arguments: { task: "replace old with new", confirm: true, previewId },
      });
      return textOf(phase2);
    });

    // git apply honors core.autocrlf, so compare line-ending-insensitively.
    assert.strictEqual(readText(path.join(dir, "target.txt")), "new\n", "the approved change must land");
    assert.match(text, /Applied the approved preview exactly/);
    assert.match(text, /\[Applied Files & Diff Summary\]\nFiles: target\.txt/);
    assert.strictEqual(calls().length, 1, "only the preview may run the worker; the apply is git's job");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("when the approved diff no longer applies, the worker re-runs with write permission and says so", async () => {
  const { dir, stub, calls } = makeFixture({ preview: STALE_DIFF, apply: "write" });

  try {
    const text = await withBridge({ dir, stub, safetyMode: "diff-review" }, async (client) => {
      const phase1 = await client.callTool({ name: "worker_implement", arguments: { task: "apply the change" } });
      return textOf(
        await client.callTool({
          name: "worker_implement",
          arguments: { task: "apply the change", confirm: true, previewId: previewIdOf(phase1) },
        })
      );
    });

    const [preview, apply] = calls();
    assert.strictEqual(sandboxOf(preview), "read-only");
    // Before the fix the confirmed apply ran with the read-only flags of the
    // gated safety mode, so an approved change could never be written.
    assert.strictEqual(sandboxOf(apply), "workspace-write");
    assert.match(text, /could not be applied verbatim/);
    assert.strictEqual(fs.readFileSync(path.join(dir, "target.txt"), "utf-8"), "new\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("interactive mode never writes something other than what the operator approved", async () => {
  // The operator approves the preview, but it no longer applies. In
  // diff-review mode the worker may redo the task; here that would write a
  // change no human saw, so the bridge must stop instead.
  const { dir, stub, calls } = makeFixture({ preview: STALE_DIFF, apply: "write" });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-mcp-home-"));
  // Play the REPL's part of the approval handshake: approve every request.
  const approver = setInterval(() => {
    const sessions = path.join(home, "sessions");
    if (!fs.existsSync(sessions)) return;
    for (const hash of fs.readdirSync(sessions)) {
      const approvals = path.join(sessions, hash, "live", "approvals");
      if (!fs.existsSync(approvals)) continue;
      for (const name of fs.readdirSync(approvals)) {
        if (!name.endsWith(".json") || name.endsWith(".decision.json")) continue;
        const decision = path.join(approvals, name.replace(/\.json$/, ".decision.json"));
        if (!fs.existsSync(decision)) fs.writeFileSync(decision, JSON.stringify({ approved: true }));
      }
    }
  }, 50);

  try {
    const text = await withBridge(
      { dir, stub, home, safetyMode: "interactive", extraEnv: { KUMO_INTERACTIVE_APPROVAL: "1" } },
      async (client) => {
        const phase1 = await client.callTool({ name: "worker_implement", arguments: { task: "apply the change" } });
        return textOf(
          await client.callTool({
            name: "worker_implement",
            arguments: { task: "apply the change", confirm: true, previewId: previewIdOf(phase1) },
          })
        );
      }
    );

    assert.match(text, /could not be applied verbatim.*nothing was written/s);
    assert.strictEqual(calls().length, 1, "the worker must not be re-run with write access");
    assert.strictEqual(readText(path.join(dir, "target.txt")), "old\n");
  } finally {
    clearInterval(approver);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("autonomous writes launch the Codex worker with workspace-write", async () => {
  const { dir, stub, calls } = makeFixture({ apply: "write" });
  try {
    await withBridge({ dir, stub, safetyMode: "autonomous" }, (client) =>
      client.callTool({ name: "worker_implement", arguments: { task: "implement the change" } })
    );
    assert.strictEqual(sandboxOf(calls()[0]), "workspace-write");
    assert.strictEqual(fs.readFileSync(path.join(dir, "target.txt"), "utf-8"), "new\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a previewId bound to another task is refused on confirmation", async () => {
  const { dir, stub } = makeFixture();

  try {
    const text = await withBridge({ dir, stub, safetyMode: "diff-review" }, async (client) => {
      const phase1 = await client.callTool({
        name: "worker_implement",
        arguments: { task: "task ALPHA" },
      });
      const previewId = previewIdOf(phase1);
      assert.ok(previewId, "phase 1 must return a preview id");

      const mismatched = await client.callTool({
        name: "worker_implement",
        arguments: { task: "task BRAVO", confirm: true, previewId },
      });
      return textOf(mismatched);
    });

    assert.match(text, /previewId does not match this task/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed apply leaves the previewId reusable", async () => {
  // The diff does not apply and the worker's own attempt fails too.
  const { dir, stub } = makeFixture({ preview: STALE_DIFF, apply: "fail" });

  try {
    const { first, second } = await withBridge(
      { dir, stub, safetyMode: "diff-review" },
      async (client) => {
        const phase1 = await client.callTool({
          name: "worker_implement",
          arguments: { task: "apply the diff" },
        });
        const previewId = previewIdOf(phase1);
        assert.ok(previewId, "phase 1 must return a preview id");

        const a = await client.callTool({
          name: "worker_implement",
          arguments: { task: "apply the diff", confirm: true, previewId },
        });
        const b = await client.callTool({
          name: "worker_implement",
          arguments: { task: "apply the diff", confirm: true, previewId },
        });
        return { first: textOf(a), second: textOf(b) };
      }
    );

    assert.match(first, /worker_implement failed/, "the apply itself must be reported as failed");
    assert.doesNotMatch(
      second,
      /unknown or expired previewId/,
      "a crashed apply must not consume the preview; the retry has to be possible"
    );
    assert.match(second, /worker_implement failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker that exits 0 with only stderr is reported as no answer, with the reason", async () => {
  const { dir, stub } = makeFixture({ quiet: true });
  try {
    const res = await withBridge({ dir, stub }, (client) =>
      client.callTool({ name: "worker_explore", arguments: { task: "map the repo" } })
    );
    assert.strictEqual(res.isError, true, "an empty answer must not look like success");
    assert.match(textOf(res), /\[NO OUTPUT\][\s\S]*permission headless mode cannot grant/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a bridge started inside a Kumo worker refuses to delegate further", async () => {
  // A worker CLI with kumo-bridge registered globally (seen with `agy mcp list`)
  // would otherwise call back into Kumo and, with write access, spawn workers
  // recursively.
  const { dir, stub, calls } = makeFixture();
  try {
    const res = await withBridge({ dir, stub, extraEnv: { KUMO_INSIDE_WORKER: "1" } }, (client) =>
      client.callTool({ name: "worker_explore", arguments: { task: "map the repo" } })
    );
    assert.match(textOf(res), /\[REFUSED\].*inside a Kumo worker/);
    assert.strictEqual(calls().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workers are launched with the nested-bridge marker in their environment", async () => {
  const { dir, stub } = makeFixture();
  const envDump = path.join(dir, "env.json");
  // Swap in a stub that records its environment instead of answering.
  const impl = path.join(dir, "stub-impl.cjs");
  fs.writeFileSync(
    impl,
    `require("fs").writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({ inside: process.env.KUMO_INSIDE_WORKER || null })); process.stdout.write("ok");`
  );
  try {
    await withBridge({ dir, stub }, (client) => client.callTool({ name: "worker_explore", arguments: { task: "x" } }));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(envDump, "utf-8")), { inside: "1" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a text-only worker is refused a read task it would have to make up", async () => {
  const { dir, stub, calls } = makeFixture();
  try {
    const res = await withBridge({ dir, stub, extraEnv: { KUMO_WORKER_PROVIDER: "ollama" } }, (client) =>
      client.callTool({ name: "worker_explore", arguments: { task: "map the repo" } })
    );
    assert.strictEqual(res.isError, true);
    assert.match(textOf(res), /\[REFUSED\].*cannot open workspace files/);
    assert.strictEqual(calls().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a text-only worker receives the contents of the files it is asked about", async () => {
  const { dir, stub, calls } = makeFixture({ reply: "summary from contents" });
  fs.writeFileSync(path.join(dir, "notes.md"), "SENTINEL-CONTENT-42\n");
  try {
    const res = await withBridge({ dir, stub, extraEnv: { KUMO_WORKER_PROVIDER: "ollama" } }, (client) =>
      client.callTool({ name: "worker_review", arguments: { task: "review notes", files: ["notes.md", "../escape.txt"] } })
    );
    assert.strictEqual(res.isError, undefined, textOf(res));
    const [call] = calls();
    const prompt = call.args.join(" ") + call.stdin;
    assert.match(prompt, /SENTINEL-CONTENT-42/, "the file's contents must be inlined");
    assert.match(prompt, /escape\.txt.*(not found|outside the workspace)/s, "paths outside the workspace are not read");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a text-only worker is refused writes instead of claiming success", async () => {
  const { dir, stub, calls } = makeFixture();
  try {
    const res = await withBridge(
      { dir, stub, safetyMode: "autonomous", extraEnv: { KUMO_WORKER_PROVIDER: "ollama" } },
      (client) =>
        client.callTool({ name: "worker_implement", arguments: { task: "implement it", files: ["target.txt"] } })
    );
    assert.match(textOf(res), /\[REFUSED\].*cannot modify files/);
    assert.strictEqual(calls().length, 0);
    assert.strictEqual(fs.readFileSync(path.join(dir, "target.txt"), "utf-8"), "old\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
