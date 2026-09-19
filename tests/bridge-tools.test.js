import "./helpers/env.js";
/**
 * bridge-tools.test.js — End-to-end MCP coverage for the worker tools.
 *
 * Everything here goes through a real `callTool` over stdio, because the
 * diff-review protocol and the provider allowlist are properties of the wire
 * contract, not of the helper functions they are built from. The worker is a
 * stub binary wired in through `CODEX_BIN`, so no provider CLI is required.
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

const CANNED_DIFF = [
  "--- a/target.txt",
  "+++ b/target.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

/**
 * Build a throwaway git workspace plus a stub "codex" binary.
 *
 * The stub succeeds and emits a unified diff when it is asked for a preview,
 * and exits non-zero otherwise — which is how the apply phase is made to fail
 * on demand. It reads the prompt from argv or stdin, since the adapter routes
 * composite prompts over stdin whenever the binary is a Windows `.cmd` shim.
 *
 * @param {string} sentinelFile - the stub touches this if it is ever run
 */
function makeFixture(sentinelFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-mcp-"));
  fs.writeFileSync(path.join(dir, "target.txt"), "old\n");
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
      cwd: dir,
      stdio: "ignore",
    });
  } catch {
    /* a non-git workspace is still a valid test target */
  }

  const impl = path.join(dir, "stub-impl.cjs");
  fs.writeFileSync(
    impl,
    `const fs = require("fs");
fs.appendFileSync(${JSON.stringify(sentinelFile)}, "codex-stub\\n");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf-8"); } catch {}
const text = process.argv.slice(2).join(" ") + stdin;
if (text.includes("DIFF PREVIEW MODE")) {
  process.stdout.write(${JSON.stringify(CANNED_DIFF)});
  process.exit(0);
}
process.stderr.write("stub apply failure");
process.exit(3);
`
  );

  let stub;
  if (process.platform === "win32") {
    stub = path.join(dir, "codex-stub.cmd");
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
  } else {
    stub = path.join(dir, "codex-stub.sh");
    fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  }

  return { dir, stub };
}

/**
 * Connect to a bridge server bound to `dir`, run `fn(client)`, then tear down.
 */
async function withBridge({ dir, stub, safetyMode, extraEnv = {} }, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-mcp-home-"));
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

const textOf = (res) => (res?.content || []).map((c) => c.text || "").join("\n");

test("an unknown worker provider is rejected before dispatch, not by a failed spawn", async () => {
  const sentinel = path.join(os.tmpdir(), `kumo-sentinel-${Date.now()}.txt`);
  const { dir, stub } = makeFixture(sentinel);

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
    assert.strictEqual(
      fs.existsSync(sentinel),
      false,
      "no worker process may be spawned for an unknown provider"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sentinel, { force: true });
  }
});

test("diff-review phase 1 previews without touching the workspace", async () => {
  const sentinel = path.join(os.tmpdir(), `kumo-sentinel-${Date.now()}-p1.txt`);
  const { dir, stub } = makeFixture(sentinel);
  const before = fs.readFileSync(path.join(dir, "target.txt"), "utf-8");

  try {
    const res = await withBridge({ dir, stub, safetyMode: "diff-review" }, (client) =>
      client.callTool({ name: "worker_implement", arguments: { task: "replace old with new" } })
    );

    const text = textOf(res);
    assert.match(text, /\[STATUS: PENDING_CONFIRMATION\]/);
    assert.match(text, /Preview ID: "prev_[0-9a-f-]+"/);
    assert.strictEqual(
      fs.readFileSync(path.join(dir, "target.txt"), "utf-8"),
      before,
      "phase 1 must not modify the workspace"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sentinel, { force: true });
  }
});

test("a previewId bound to another task is refused on confirmation", async () => {
  const sentinel = path.join(os.tmpdir(), `kumo-sentinel-${Date.now()}-hash.txt`);
  const { dir, stub } = makeFixture(sentinel);

  try {
    const text = await withBridge({ dir, stub, safetyMode: "diff-review" }, async (client) => {
      const phase1 = await client.callTool({
        name: "worker_implement",
        arguments: { task: "task ALPHA" },
      });
      const previewId = textOf(phase1).match(/Preview ID: "([^"]+)"/)?.[1];
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
    fs.rmSync(sentinel, { force: true });
  }
});

test("a failed apply leaves the previewId reusable", async () => {
  const sentinel = path.join(os.tmpdir(), `kumo-sentinel-${Date.now()}-retry.txt`);
  const { dir, stub } = makeFixture(sentinel);

  try {
    const { first, second } = await withBridge(
      { dir, stub, safetyMode: "diff-review" },
      async (client) => {
        const phase1 = await client.callTool({
          name: "worker_implement",
          arguments: { task: "apply the diff" },
        });
        const previewId = textOf(phase1).match(/Preview ID: "([^"]+)"/)?.[1];
        assert.ok(previewId, "phase 1 must return a preview id");

        // The stub exits non-zero for the apply phase, simulating a crash.
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
    fs.rmSync(sentinel, { force: true });
  }
});
