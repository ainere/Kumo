import "./helpers/env.js";
/**
 * model-picker-and-gradient.test.js — Verification tests for the blueish gradient progress bar,
 * model discovery, and active model scoping.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { progressBar, BLUEISH_GRADIENT } from "../src/utils/ui.js";
import { getAgyModels, DEFAULT_WORKER_MODELS } from "../src/bridge/agy-runner.js";
import { getOrchestratorModels, DEFAULT_CODEX_MODELS } from "../src/utils/model-picker.js";
test("progressBar renders with blueish gradient colors for filled blocks", () => {
  const bar = progressBar(50, 14);
  assert.ok(bar.includes("50%"), "Bar must contain 50%");
  assert.ok(bar.includes("█"), "Bar must contain filled blocks");
  assert.ok(bar.includes("░"), "Bar must contain empty blocks");

  // Check that at least one of the blueish gradient color codes is present
  const hasBlueish = BLUEISH_GRADIENT.some((code) => bar.includes(code));
  assert.ok(hasBlueish, "Progress bar filled blocks must contain blueish gradient colors");
});

test("progressBar clamps correctly from 0 to 100", () => {
  const barZero = progressBar(0, 14);
  assert.ok(barZero.includes("0%"));
  assert.ok(!barZero.includes("█"));

  const barFull = progressBar(100, 14);
  assert.ok(barFull.includes("100%"));
  assert.ok(!barFull.includes("░"));
});


/** Point AGY_BIN at a stub that runs `script`, for the duration of `fn`. */
async function withAgyStub(script, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-agy-models-"));
  const impl = path.join(dir, "agy.cjs");
  fs.writeFileSync(impl, script);
  const stub =
    process.platform === "win32" ? path.join(dir, "agy.cmd") : path.join(dir, "agy.sh");
  if (process.platform === "win32") {
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
  } else {
    fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  }
  const saved = process.env.AGY_BIN;
  process.env.AGY_BIN = stub;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("getAgyModels parses `agy models` output, folding effort variants", async () => {
  // The old test only asserted "a non-empty list containing gemini", which the
  // hard-coded fallback satisfies whenever the CLI fails — so it stayed green
  // on machines where the binary could not even be spawned.
  const listing = [
    "Fetching models...",
    "gemini-9-flash-high\tGemini 9 Flash (High)",
    "gemini-9-flash-low\tGemini 9 Flash (Low)",
    "claude-test-1\tClaude Test 1",
  ].join("\n");
  const models = await withAgyStub(`process.stdout.write(${JSON.stringify(listing)});`, () => getAgyModels());
  assert.deepStrictEqual(models, [
    { id: "gemini-9-flash", name: "Gemini 9 Flash" },
    { id: "claude-test-1", name: "Claude Test 1" },
  ]);
});

test("getAgyModels falls back to the default list when the CLI fails", async () => {
  const models = await withAgyStub("process.exit(1);", () => getAgyModels());
  assert.deepStrictEqual(models, DEFAULT_WORKER_MODELS);
});

test("getOrchestratorModels falls back to DEFAULT_CODEX_MODELS when binary missing", async () => {
  const prev = process.env.CODEX_BIN;
  process.env.CODEX_BIN = path.join(os.tmpdir(), "kumo-no-such-codex");
  try {
    const models = await getOrchestratorModels();
    assert.deepStrictEqual(models, DEFAULT_CODEX_MODELS);
  } finally {
    if (prev === undefined) {
      delete process.env.CODEX_BIN;
    } else {
      process.env.CODEX_BIN = prev;
    }
  }
});


test("resolveModel resolves friendly aliases like luna and opus", async () => {
  const { resolveModel } = await import("../src/config/settings.js");

  assert.strictEqual(resolveModel("luna"), "gpt-6-luna");
  assert.strictEqual(resolveModel("astra"), "gpt-6-astra");
  assert.strictEqual(resolveModel("sol"), "gpt-6.1-sol");
  assert.strictEqual(resolveModel("terra"), "gpt-5.6-terra");
  assert.strictEqual(resolveModel("custom-model"), "custom-model");

  assert.strictEqual(resolveModel("opus"), "claude-opus-5-5");
  assert.strictEqual(resolveModel("sonnet"), "claude-sonnet-5-5");
  assert.strictEqual(resolveModel("haiku"), "claude-haiku-5-5");
  assert.strictEqual(resolveModel("fable"), "claude-fable-5-1");
  assert.strictEqual(resolveModel("flash"), "gemini-3.8-flash");
  assert.strictEqual(resolveModel("argon"), "gemini-4-argon");
  assert.strictEqual(resolveModel("custom-worker"), "custom-worker");
});
