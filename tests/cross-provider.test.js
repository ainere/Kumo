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

test("AgyAppClient guarantees stable matching item.id across item_started and item_completed", () => {
  const client = new AgyAppClient();
  const started = [];
  const completed = [];

  client.on("item_started", (p) => started.push(p));
  client.on("item_completed", (p) => completed.push(p));

  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      tool_input: { task: "inspect repo" },
    },
  });

  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      state: "DONE",
    },
  });

  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.ok(started[0].item.id, "item_started must carry a truthy item.id");
  assert.equal(started[0].item.id, completed[0].item.id, "start and completed ids must match");
});

test("AgyAppClient and activeTools map handle concurrent tool calls without state clobbering", () => {
  const client = new AgyAppClient();
  const activeTools = new Map();

  client.on("item_started", (params) => {
    const item = params.item;
    activeTools.set(item.id, item);
  });
  client.on("item_completed", (params) => {
    activeTools.delete(params.item.id);
  });

  // Start tool 1
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      tool_input: { task: "task 1" },
    },
  });
  // Start tool 2 concurrently
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_implement",
      tool_input: { task: "task 2" },
    },
  });

  assert.equal(activeTools.size, 2, "Both concurrent tools must be active simultaneously");

  // Complete tool 1
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      state: "DONE",
    },
  });

  assert.equal(activeTools.size, 1, "Tool 2 must remain active after tool 1 completes");
  const remaining = Array.from(activeTools.values())[0];
  assert.equal(remaining.name, "worker_implement");

  // Complete tool 2
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_implement",
      state: "DONE",
    },
  });

  assert.equal(activeTools.size, 0, "All tools should be completed");
});

test("AgyAppClient correctly matches out-of-order completions for identical tool names by task signature", () => {
  const client = new AgyAppClient();
  const started = [];
  const completed = [];

  client.on("item_started", (p) => started.push(p));
  client.on("item_completed", (p) => completed.push(p));

  // Two concurrent calls of the SAME tool name
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      tool_input: { task: "explore auth flow" },
    },
  });
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      tool_input: { task: "explore database schema" },
    },
  });

  assert.equal(started.length, 2);
  const id1 = started[0].item.id;
  const id2 = started[1].item.id;
  assert.notEqual(id1, id2, "Must assign distinct IDs");

  // Second tool finishes first
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      tool_input: { task: "explore database schema" },
      state: "DONE",
    },
  });

  // First tool finishes second
  client._handleStreamEvent({
    event: "step_update",
    step_update: {
      step_type: "tool_call",
      tool_name: "worker_explore",
      tool_input: { task: "explore auth flow" },
      state: "DONE",
    },
  });

  assert.equal(completed.length, 2);
  assert.equal(completed[0].item.id, id2, "First completion must match the second call (database schema)");
  assert.equal(completed[1].item.id, id1, "Second completion must match the first call (auth flow)");
});


