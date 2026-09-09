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
      "gemini_explore",
      "gemini_implement",
      "gemini_test",
      "gemini_research",
      "gemini_review",
    ];

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
