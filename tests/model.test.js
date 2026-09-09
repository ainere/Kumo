/**
 * model.test.js — Verification tests for model and reasoning effort configuration.
 */

import { test } from "node:test";
import assert from "node:assert";
import { loadConfig, setConfigValue, applyPreset, PRESETS } from "../src/config/settings.js";
import { effortCommand, modelCommand } from "../src/commands/model.js";

test("PRESETS includes test preset with gpt-5.5 low and gemini-3.6-flash low for tests", () => {
  assert.ok(PRESETS.test, "Expected 'test' preset to exist");
  assert.strictEqual(PRESETS.test.config.orchestratorModel, "gpt-5.5");
  assert.strictEqual(PRESETS.test.config.reasoningEffort, "low");
  assert.strictEqual(PRESETS.test.config.workerModel, "gemini-3.6-flash");
  assert.strictEqual(PRESETS.test.config.workerEffort, "low");
});

test("effortCommand updates reasoningEffort setting in config", () => {
  effortCommand("low");
  const config = loadConfig();
  assert.strictEqual(config.reasoningEffort, "low");

  effortCommand("medium");
  const updated = loadConfig();
  assert.strictEqual(updated.reasoningEffort, "medium");

  // Restore to low for quota preservation
  effortCommand("low");
  assert.strictEqual(loadConfig().reasoningEffort, "low");
});

test("effortCommand updates workerEffort setting in config", () => {
  effortCommand("worker", "low");
  const config = loadConfig();
  assert.strictEqual(config.workerEffort, "low");

  // Restore to medium
  effortCommand("worker", "medium");
  assert.strictEqual(loadConfig().workerEffort, "medium");
});

test("modelCommand shorthand updates orchestrator model", () => {
  modelCommand("chatgpt-6-astra");
  const config = loadConfig();
  assert.strictEqual(config.orchestratorModel, "chatgpt-6-astra");
});
