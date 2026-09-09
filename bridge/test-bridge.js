/**
 * test-bridge.js — Automated smoke test for MCP bridge server.
 * Connects via Client transport to verify that all tools are registered.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function runTest() {
  console.log("Starting MCP bridge server test...");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["server.js"],
    cwd: process.cwd(),
  });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("✓ Connected to MCP bridge server successfully.");

    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name);
    console.log("✓ Registered tools found:", toolNames);

    const expected = [
      "gemini_explore",
      "gemini_implement",
      "gemini_test",
      "gemini_research",
      "gemini_review",
    ];

    const missing = expected.filter((name) => !toolNames.includes(name));
    if (missing.length > 0) {
      throw new Error(`Missing expected tools: ${missing.join(", ")}`);
    }

    console.log("✓ All expected Gemini tools are registered!");
    console.log("✓ Bridge server test passed.");
  } finally {
    await transport.close();
  }
}

runTest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
