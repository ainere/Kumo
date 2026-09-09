/**
 * model.test.js — Verification tests for model and reasoning effort configuration.
 */

import { test } from "node:test";
import assert from "node:assert";
import { loadConfig, setConfigValue, applyPreset, PRESETS } from "../src/config/settings.js";
import { effortCommand, modelCommand } from "../src/commands/model.js";

test("PRESETS includes go preset with gpt-5.5 and low effort for quota preservation", () => {
  assert.ok(PRESETS.go, "Expected 'go' preset to exist");
  assert.strictEqual(PRESETS.go.config.orchestratorModel, "gpt-5.5");
  assert.strictEqual(PRESETS.go.config.reasoningEffort, "low");
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

test("modelCommand shorthand updates orchestrator model", () => {
  modelCommand("gpt-5.5");
  const config = loadConfig();
  assert.strictEqual(config.orchestratorModel, "gpt-5.5");
});
