import "./helpers/env.js";
/**
 * model-picker-and-gradient.test.js — Verification tests for the blueish gradient progress bar,
 * model discovery, and active model scoping.
 */

import { test } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { progressBar, BLUEISH_GRADIENT } from "../src/utils/ui.js";
import { getAgyModels } from "../src/bridge/agy-runner.js";
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


test("getAgyModels resolves available models", async () => {
  const models = await getAgyModels();
  assert.ok(Array.isArray(models) && models.length > 0);
  assert.ok(models.some((m) => m.id.includes("gemini")));
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

  assert.strictEqual(resolveModel("luna"), "gpt-5.6-luna");
  assert.strictEqual(resolveModel("astra"), "chatgpt-6-astra");
  assert.strictEqual(resolveModel("sol"), "chatgpt-5.6-sol");
  assert.strictEqual(resolveModel("terra"), "gpt-5.6-terra");
  assert.strictEqual(resolveModel("custom-model"), "custom-model");

  assert.strictEqual(resolveModel("opus"), "claude-opus-4-6-thinking");
  assert.strictEqual(resolveModel("sonnet"), "claude-sonnet-4-6");
  assert.strictEqual(resolveModel("flash"), "gemini-3.8-flash");
  assert.strictEqual(resolveModel("pro"), "gemini-3.1-pro");
  assert.strictEqual(resolveModel("custom-worker"), "custom-worker");
});
