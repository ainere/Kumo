import "./helpers/env.js";
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

// Each assertion sets a value that differs from both the default and the
// previous step: setting the default and reading it back passes even when the
// command does nothing at all.

test("effortCommand updates reasoningEffort setting in config", () => {
  assert.notStrictEqual(loadConfig().reasoningEffort, "high", "precondition: not already high");
  effortCommand("high");
  assert.strictEqual(loadConfig().reasoningEffort, "high");

  effortCommand("medium");
  assert.strictEqual(loadConfig().reasoningEffort, "medium");
});

test("effortCommand updates workerEffort setting in config", () => {
  assert.notStrictEqual(loadConfig().workerEffort, "low", "precondition: not already low");
  effortCommand("worker", "low");
  assert.strictEqual(loadConfig().workerEffort, "low");

  effortCommand("worker", "high");
  assert.strictEqual(loadConfig().workerEffort, "high");
});

test("modelCommand shorthand updates orchestrator model", async () => {
  assert.notStrictEqual(loadConfig().orchestratorModel, "gpt-5.6-luna", "precondition: a different model");
  await modelCommand("gpt-5.6-luna");
  assert.strictEqual(loadConfig().orchestratorModel, "gpt-5.6-luna");
});
