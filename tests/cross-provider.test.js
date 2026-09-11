import test from "node:test";
import assert from "node:assert/strict";

import {
  detectProviderForModel,
  supportsEffort,
  PRESETS,
  resolveOrchestratorModel,
  resolveWorkerModel,
} from "../src/config/settings.js";
import {
  createOrchestratorClient,
  getOrchestrator,
  listOrchestrators,
} from "../src/providers/orchestrators/registry.js";
import { CodexAppClient } from "../src/providers/orchestrators/codex-client.js";
import { AgyAppClient } from "../src/providers/orchestrators/agy-client.js";
import { ClaudeAppClient } from "../src/providers/orchestrators/claude-client.js";
import { getWorker, listWorkers } from "../src/providers/workers/registry.js";

test("detectProviderForModel maps models to the correct providers", () => {
  assert.equal(detectProviderForModel("chatgpt-6-astra"), "codex");
  assert.equal(detectProviderForModel("gpt-5.5"), "codex");
  assert.equal(detectProviderForModel("gemini-3.8-flash"), "antigravity");
  assert.equal(detectProviderForModel("claude-opus-4-6-thinking"), "antigravity");
  assert.equal(detectProviderForModel("claude-opus-4-6-thinking", "claude"), "claude");
});

test("supportsEffort correctly flags models that do or do not accept --effort", () => {
  assert.equal(supportsEffort("chatgpt-6-astra"), true);
  assert.equal(supportsEffort("gemini-3.8-flash"), true);
  // Claude models do not accept --effort flag
  assert.equal(supportsEffort("claude-opus-4-6-thinking"), false);
  assert.equal(supportsEffort("claude-sonnet-4-6"), false);
  // Pre-suffixed models do not accept another effort flag
  assert.equal(supportsEffort("chatgpt-6-astra-low"), false);
  assert.equal(supportsEffort("chatgpt-6-astra-high"), false);
});

test("createOrchestratorClient instantiates appropriate client per provider", () => {
  const codexClient = createOrchestratorClient({ model: "chatgpt-6-astra" });
  assert.ok(codexClient instanceof CodexAppClient);

  const agyClient = createOrchestratorClient({ model: "claude-opus-4-6-thinking" });
  assert.ok(agyClient instanceof AgyAppClient);

  const agyExplicitClient = createOrchestratorClient({
    provider: "antigravity",
    model: "gemini-3.8-flash",
  });
  assert.ok(agyExplicitClient instanceof AgyAppClient);

  const claudeClient = createOrchestratorClient({ provider: "claude" });
  assert.ok(claudeClient instanceof ClaudeAppClient);
});

test("getWorker returns valid execution worker with executeTask for all supported providers", () => {
  for (const provider of ["gemini", "antigravity", "codex", "claude"]) {
    const worker = getWorker(provider);
    assert.ok(worker, `Worker should exist for provider ${provider}`);
    assert.equal(typeof worker.executeTask, "function", `Worker ${provider} must have executeTask`);
  }
});

test("listOrchestrators and listWorkers return canonical lists", () => {
  const orchestrators = listOrchestrators();
  assert.ok(orchestrators.some((o) => o.id === "codex"));
  assert.ok(orchestrators.some((o) => o.id === "antigravity"));
  assert.ok(orchestrators.some((o) => o.id === "claude"));

  const workers = listWorkers();
  assert.ok(workers.some((w) => w.id === "gemini"));
  assert.ok(workers.some((w) => w.id === "codex"));
  assert.ok(workers.some((w) => w.id === "claude"));
});

test("PRESETS includes cross-provider presets like opus-astra and opus-flash", () => {
  assert.ok(PRESETS["opus-astra"]);
  assert.equal(PRESETS["opus-astra"].config.orchestratorModel, "claude-opus-4-6-thinking");
  assert.equal(PRESETS["opus-astra"].config.workerModel, "chatgpt-6-astra");

  assert.ok(PRESETS["opus-flash"]);
  assert.equal(PRESETS["opus-flash"].config.orchestratorModel, "claude-opus-4-6-thinking");
  assert.equal(PRESETS["opus-flash"].config.workerModel, "gemini-3.8-flash");
});

test("createOrchestratorClient and getWorker support arbitrary providers like opencode, commandcode, and custom CLI tools", () => {
  const opencodeClient = createOrchestratorClient({ provider: "opencode", model: "custom-model-x" });
  assert.equal(opencodeClient.activeModel, "custom-model-x");

  const customClient = createOrchestratorClient({ provider: "ollama", model: "deepseek-r1" });
  assert.equal(customClient.activeModel, "deepseek-r1");
  assert.equal(customClient.command, "ollama");

  const opencodeWorker = getWorker("opencode");
  assert.equal(typeof opencodeWorker.executeTask, "function");

  const commandcodeWorker = getWorker("commandcode");
  assert.equal(typeof commandcodeWorker.executeTask, "function");

  const arbitraryWorker = getWorker("ollama");
  assert.equal(typeof arbitraryWorker.executeTask, "function");
});

test("clients do not force hardcoded models and accept custom model strings freely", () => {
  const claudeCustom = new ClaudeAppClient({ model: "claude-3-7-sonnet-20250219" });
  assert.equal(claudeCustom.activeModel, "claude-3-7-sonnet-20250219");

  const agyCustom = new AgyAppClient({ model: "gemini-2.5-pro" });
  assert.equal(agyCustom.activeModel, "gemini-2.5-pro");

  const claudeEmpty = new ClaudeAppClient();
  assert.equal(claudeEmpty.activeModel, null);

  const agyEmpty = new AgyAppClient();
  assert.equal(agyEmpty.activeModel, null);
});

