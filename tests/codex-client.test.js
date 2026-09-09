/**
 * codex-client.test.js — Verification tests for CodexAppClient JSON-RPC protocol.
 */

import { test } from "node:test";
import assert from "node:assert";
import { CodexAppClient } from "../src/providers/orchestrators/codex-client.js";
import { findCodexBinary } from "../src/providers/orchestrators/codex.js";

test("findCodexBinary locates executable", () => {
  const bin = findCodexBinary();
  assert.ok(bin && bin.length > 0);
});

test("CodexAppClient initializes and retrieves live account rate limits", async () => {
  const client = new CodexAppClient();
  await client.start();

  try {
    const limits = await client.getRateLimits();
    assert.ok(limits, "Expected rate limit response");
    assert.ok(typeof limits.usedPercent === "number", "usedPercent should be a number");
    assert.ok(limits.planType, "planType should be defined");
    assert.ok(limits.resetFormatted, "resetFormatted should be defined");
  } finally {
    await client.stop();
  }
});
