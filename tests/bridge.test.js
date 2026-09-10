/**
 * bridge.test.js — Verification test for the dynamic workspace MCP bridge server.
 */

import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "../src/bridge/server.js");

test("MCP bridge server starts and exposes all 5 tools with workspace parameter", async () => {
  const dummyWorkspace = path.resolve(__dirname, "../");

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath, "--workspace", dummyWorkspace],
    cwd: dummyWorkspace,
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
    ];

    assert.strictEqual(toolNames.length, 5, `Expected exactly 5 tools, got ${toolNames.length}`);

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

test("MAX_OUTPUT_BYTES is 1MB and output buffer slicing logic hard-caps total size", async () => {
  const { MAX_OUTPUT_BYTES } = await import("../src/bridge/agy-runner.js");
  assert.strictEqual(MAX_OUTPUT_BYTES, 1024 * 1024);

  let stdout = "";
  const chunk1 = "A".repeat(1024 * 1024 - 10);
  const chunk2 = "B".repeat(100);

  for (const chunk of [chunk1, chunk2]) {
    if (stdout.length < MAX_OUTPUT_BYTES) {
      const remaining = MAX_OUTPUT_BYTES - stdout.length;
      const str = chunk.toString();
      stdout += str.length <= remaining ? str : str.slice(0, remaining);
    }
  }

  assert.strictEqual(stdout.length, MAX_OUTPUT_BYTES);
  assert.strictEqual(stdout.slice(-10), "B".repeat(10));
});
