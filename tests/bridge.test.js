import "./helpers/env.js";
/**
 * bridge.test.js — Verification test for the dynamic workspace MCP bridge server.
 */

import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../src/bridge/server.js");

/**
 * The bridge child's environment. Without an explicit `env`, the MCP SDK
 * passes only a short allowlist of variables, so the test sandbox (KUMO_HOME,
 * KUMO_NO_SYNC) never reached the child and it used the real ~/.kumo.
 */
const sandboxEnv = () => ({ ...process.env });

/**
 * Write an executable stub that prints `bytes` bytes to stdout and exits 0.
 * On Windows it must be a real `.cmd`, since that is what npm-installed CLIs
 * actually are and what the spawn path has to cope with.
 *
 * @param {string} dir
 * @param {number} bytes
 * @returns {string} path to the stub
 */
function writeFloodStub(dir, bytes) {
  const script = `process.stdout.write("A".repeat(${bytes}));`;
  if (process.platform === "win32") {
    const stub = path.join(dir, "flood.cmd");
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" -e "${script.replace(/"/g, '\\"')}"\r\n`);
    return stub;
  }
  const stub = path.join(dir, "flood.sh");
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" -e '${script}'\n`, { mode: 0o755 });
  return stub;
}

test("MCP bridge server starts and exposes one tool per built-in role", async () => {
  const dummyWorkspace = path.resolve(__dirname, "../");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--workspace", dummyWorkspace],
    cwd: dummyWorkspace,
    env: sandboxEnv(),
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name);

    const expectedTools = [
      "worker_explore",
      "worker_implement",
      "worker_test",
      "worker_research",
      "worker_review",
      "worker_design",
    ];

    assert.strictEqual(toolNames.length, 6, `Expected exactly 6 tools, got ${toolNames.length}`);

    for (const exp of expectedTools) {
      assert.ok(
        toolNames.includes(exp),
        `Expected tool ${exp} to be present in ${JSON.stringify(toolNames)}`
      );
    }
  } finally {
    await transport.close();
  }
});

test("runAgy hard-caps captured stdout at MAX_OUTPUT_BYTES", async () => {
  const { runAgy, MAX_OUTPUT_BYTES } = await import("../src/bridge/agy-runner.js");
  assert.strictEqual(MAX_OUTPUT_BYTES, 1024 * 1024);

  // Drive the real accumulator through a stub binary that floods stdout.
  // This test previously reimplemented the slicing inside its own body, so
  // removing the cap from agy-runner.js left it green.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-agy-stub-"));
  const stub = writeFloodStub(dir, MAX_OUTPUT_BYTES + 4096);
  const saved = process.env.AGY_BIN;
  process.env.AGY_BIN = stub;

  try {
    const res = await runAgy({
      prompt: "ignored by the stub",
      mode: "read-only",
      model: null,
      effort: null,
      trustWorkspace: false,
      workspace: dir,
      timeoutMs: 60000,
    });

    assert.strictEqual(res.stdout.length, MAX_OUTPUT_BYTES, "stdout must be truncated to the cap");
    assert.strictEqual(res.ok, true);
  } finally {
    if (saved === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP bridge tools expose optional model and effort schema properties", async () => {
  const dummyWorkspace = path.resolve(__dirname, "../");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--workspace", dummyWorkspace],
    cwd: dummyWorkspace,
    env: sandboxEnv(),
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.inputSchema.properties.model, `${tool.name} should accept optional model`);
      assert.ok(tool.inputSchema.properties.effort, `${tool.name} should accept optional effort`);
    }
  } finally {
    await transport.close();
  }
});
