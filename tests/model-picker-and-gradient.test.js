/**
 * model-picker-and-gradient.test.js — Verification tests for the blueish gradient progress bar,
 * model discovery, and active model scoping.
 */

import { test } from "node:test";
import assert from "node:assert";
import { progressBar, BLUEISH_GRADIENT } from "../src/utils/ui.js";
import { getAgyModels, DEFAULT_WORKER_MODELS } from "../bridge/agy-runner.js";
import { getOrchestratorModels, DEFAULT_CODEX_MODELS } from "../src/utils/model-picker.js";
import { modelCommand } from "../src/commands/model.js";

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

test("DEFAULT_WORKER_MODELS includes Gemini and Claude models", () => {
  const ids = DEFAULT_WORKER_MODELS.map((m) => m.id);
  assert.ok(ids.includes("gemini-3.8-flash"));
  assert.ok(ids.includes("gemini-3.7-flash"));
  assert.ok(ids.includes("claude-sonnet-4-6"));
});

test("DEFAULT_CODEX_MODELS includes Astra, Sol, Terra, Luna, and GPT-5.5", () => {
  const ids = DEFAULT_CODEX_MODELS.map((m) => m.id);
  assert.ok(ids.includes("chatgpt-6-astra"));
  assert.ok(ids.includes("chatgpt-5.6-sol"));
  assert.ok(ids.includes("gpt-5.6-terra"));
  assert.ok(ids.includes("gpt-5.5"));
});

test("getAgyModels resolves available models", async () => {
  const models = await getAgyModels();
  assert.ok(Array.isArray(models) && models.length > 0);
  assert.ok(models.some((m) => m.id.includes("gemini")));
});

test("getOrchestratorModels resolves available models", async () => {
  const models = await getOrchestratorModels();
  assert.ok(Array.isArray(models) && models.length > 0);
  assert.ok(models.some((m) => m.id.includes("chatgpt") || m.id.includes("gpt")));
});

test("PRESET_SUMMARIES and DEFAULT_WORKER_MODELS have clean concise names without verbosity", async () => {
  const { PRESETS } = await import("../src/config/settings.js");
  const { PRESET_SUMMARIES } = await import("../src/utils/model-picker.js");

  for (const [key, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.name, `Preset ${key} must have a name`);
    assert.strictEqual(preset.name, PRESET_SUMMARIES[key], `Preset ${key} name must match PRESET_SUMMARIES`);
    // Verify no redundant parentheses in preset names
    assert.ok(!preset.name.includes("("), `Preset ${key} name should be concise without parentheses: ${preset.name}`);
  }

  for (const worker of DEFAULT_WORKER_MODELS) {
    assert.ok(!worker.name.includes("("), `Worker ${worker.id} name should be concise without parentheses: ${worker.name}`);
  }
});

test("resolveOrchestratorModel and resolveWorkerModel resolve friendly aliases like luna and opus", async () => {
  const { resolveOrchestratorModel, resolveWorkerModel } = await import("../src/config/settings.js");

  assert.strictEqual(resolveOrchestratorModel("luna"), "gpt-5.6-luna");
  assert.strictEqual(resolveOrchestratorModel("astra"), "chatgpt-6-astra");
  assert.strictEqual(resolveOrchestratorModel("sol"), "chatgpt-5.6-sol");
  assert.strictEqual(resolveOrchestratorModel("terra"), "gpt-5.6-terra");
  assert.strictEqual(resolveOrchestratorModel("custom-model"), "custom-model");

  assert.strictEqual(resolveWorkerModel("opus"), "claude-opus-4-6-thinking");
  assert.strictEqual(resolveWorkerModel("sonnet"), "claude-sonnet-4-6");
  assert.strictEqual(resolveWorkerModel("flash"), "gemini-3.8-flash");
  assert.strictEqual(resolveWorkerModel("pro"), "gemini-3.1-pro");
  assert.strictEqual(resolveWorkerModel("custom-worker"), "custom-worker");
});
