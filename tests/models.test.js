import "./helpers/env.js";
/**
 * models.test.js — The model catalog: what each provider offers, and which
 * provider a model switch lands on.
 *
 * The lists used to be copied across five files and drifted: Kumo offered
 * Codex ids no Codex accepts (`chatgpt-6-astra`), Antigravity models agy had
 * dropped, and only one Claude generation.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  MODEL_CATALOG,
  EFFORT_LEVELS,
  providerForModel,
  providerOffersModel,
  planLabel,
} from "../src/config/models.js";
import { PRESETS, loadConfig, setConfigValue } from "../src/config/settings.js";
import { modelsForProvider } from "../src/utils/model-picker.js";
import { configFile } from "../src/config/paths.js";

test("switching to a model keeps the current provider only when it offers that model", () => {
  // Antigravity offers Claude Opus 5.5, so /model opus stays there.
  assert.strictEqual(providerForModel("claude-opus-5-5", "antigravity"), "antigravity");
  // Codex does not; keeping it sent a Claude id to Codex, which rejected it.
  assert.strictEqual(providerForModel("claude-opus-5-5", "codex"), "claude");
  // Haiku is not on Antigravity at all.
  assert.strictEqual(providerForModel("claude-haiku-5-5", "antigravity"), "claude");
  assert.strictEqual(providerForModel("gpt-5.6-terra", "claude"), "codex");
  // Providers that take any id keep it.
  assert.strictEqual(providerForModel("llama3.1", "ollama"), "ollama");
  assert.strictEqual(providerForModel("my-model", "compat-api"), "compat-api");
});

test("the Claude provider lists Claude models, not the Codex or Gemini lists", async () => {
  const claude = await modelsForProvider("claude");
  const ids = claude.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-5-5") && ids.includes("claude-haiku-5-5") && ids.includes("claude-fable-5-1"));
  assert.ok(ids.includes("claude-opus-4-6"), "earlier generations stay selectable");
  assert.ok(ids.every((id) => id.startsWith("claude-")), ids.join(", "));
});

test("Codex models use the gpt- slugs Codex accepts", () => {
  const ids = MODEL_CATALOG.codex.map((m) => m.id);
  assert.deepStrictEqual(ids.slice(0, 3), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
  assert.ok(!ids.some((id) => id.startsWith("chatgpt-")));
  assert.ok(!ids.includes("gpt-5.5"), "GPT-5.5 retired from Codex with ChatGPT sign-in on 2026-10-14");
});

test("every preset names a provider that offers its models", () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const { orchestratorProvider, orchestratorModel, workerProvider, workerModel } = preset.config;
    assert.ok(providerOffersModel(orchestratorProvider, orchestratorModel), `${name}: ${orchestratorProvider} ${orchestratorModel}`);
    assert.ok(providerOffersModel(workerProvider, workerModel), `${name}: ${workerProvider} ${workerModel}`);
    for (const effort of [preset.config.reasoningEffort, preset.config.workerEffort]) {
      assert.ok(EFFORT_LEVELS.includes(effort), `${name}: effort ${effort}`);
    }
  }
});

test("a config written with an old Codex id loads as the model it meant", () => {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  const saved = fs.existsSync(configFile()) ? fs.readFileSync(configFile(), "utf-8") : null;
  try {
    fs.writeFileSync(configFile(), JSON.stringify({ orchestratorModel: "chatgpt-6-astra", workerModel: "gemini-3.8-flash" }));
    assert.strictEqual(loadConfig().orchestratorModel, "gpt-6-astra");
    assert.strictEqual(loadConfig().workerModel, "gemini-3.8-flash");
  } finally {
    if (saved === null) fs.rmSync(configFile(), { force: true });
    else fs.writeFileSync(configFile(), saved);
  }
});

test("xhigh is an accepted effort for both roles", () => {
  const saved = fs.existsSync(configFile()) ? fs.readFileSync(configFile(), "utf-8") : null;
  try {
    setConfigValue("reasoningEffort", "xhigh");
    setConfigValue("workerEffort", "xhigh");
    assert.strictEqual(loadConfig().reasoningEffort, "xhigh");
    assert.strictEqual(loadConfig().workerEffort, "xhigh");
    assert.throws(() => setConfigValue("workerEffort", "ultra"));
  } finally {
    if (saved === null) fs.rmSync(configFile(), { force: true });
    else fs.writeFileSync(configFile(), saved);
  }
});

test("plan labels follow the provider, not just the model name", () => {
  assert.strictEqual(planLabel("claude", "claude-opus-5-5"), "Claude subscription");
  assert.strictEqual(planLabel("antigravity", "claude-opus-5-5"), "Anthropic via Antigravity");
  assert.strictEqual(planLabel("anthropic-api", "claude-opus-5-5"), "Direct API (anthropic-api)");
  assert.strictEqual(planLabel("codex", "gpt-6-astra", { planType: "ChatGPT Pro" }), "ChatGPT Pro");
});
