import "./helpers/env.js";
import test from "node:test";
import assert from "node:assert/strict";

import {
  detectProviderForModel,
  supportsEffort,
  PRESETS,
  resolveModel,
} from "../src/config/settings.js";
import {
  createOrchestratorClient,
  getOrchestrator,
  listOrchestrators,
  orchestratorDelegates,
} from "../src/providers/orchestrators/registry.js";
import { CodexAppClient } from "../src/providers/orchestrators/codex-client.js";
import { AgyAppClient } from "../src/providers/orchestrators/agy-client.js";
import { ClaudeAppClient } from "../src/providers/orchestrators/claude-client.js";
import { isToolCallItem, toolNameOf, toolArgsOf } from "../src/providers/orchestrators/items.js";
import { getWorker, listWorkers, workerCapabilities } from "../src/providers/workers/registry.js";

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
  assert.equal(supportsEffort("gpt-oss-120b"), true);
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

test("worker capabilities say which workers can write files or read the workspace", () => {
  for (const provider of ["gemini", "antigravity", "codex", "claude", "cursor", "gemini-cli"]) {
    assert.deepEqual(workerCapabilities(provider), { canWrite: true, readsWorkspace: true }, provider);
  }
  // Plain model calls: no filesystem. The bridge refuses or inlines files for these.
  for (const provider of ["ollama", "openai-api", "anthropic-api", "gemini-api", "compat-api"]) {
    assert.deepEqual(workerCapabilities(provider), { canWrite: false, readsWorkspace: false }, provider);
  }
});

test("only orchestrators wired to the bridge are reported as able to delegate", () => {
  for (const provider of ["codex", "claude", "antigravity", "gemini", "agy"]) {
    assert.equal(orchestratorDelegates(provider), true, provider);
  }
  for (const provider of ["ollama", "opencode", "copilot", "cursor", "gemini-cli", "openai-api", "nope"]) {
    assert.equal(orchestratorDelegates(provider), false, provider);
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

test("an unregistered CLI becomes a worker or orchestrator only with an explicit opt-in", () => {
  // The id becomes the executable that is spawned, so a model-authored value
  // must never reach the generic adapter implicitly.
  assert.throws(() => getWorker("my-agent-cli"), /Unknown worker provider 'my-agent-cli'/);
  assert.equal(getWorker("my-agent-cli", { allowGeneric: true }).PROVIDER_INFO.id, "my-agent-cli");

  assert.throws(() => createOrchestratorClient({ provider: "my-agent-cli" }), /Unknown orchestrator provider/);
  const custom = createOrchestratorClient({ provider: "my-agent-cli", model: "m1", allowGeneric: true });
  assert.equal(custom.command, "my-agent-cli");
  assert.equal(custom.activeModel, "m1");
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

test("Antigravity tool events satisfy the item contract the REPL reads", () => {
  // The previous version of this test rebuilt the REPL's activeTools map
  // inside the test body, so it tested its own copy of the logic. What the
  // REPL actually depends on is the shared item helpers; check those against
  // the events the real client emits.
  const client = new AgyAppClient();
  const started = [];
  const completed = [];
  client.on("item_started", (p) => started.push(p.item));
  client.on("item_completed", (p) => completed.push(p.item));

  client._handleStreamEvent({
    event: "step_update",
    step_update: { step_type: "call_mcp_tool", tool_name: "worker_implement", tool_input: { task: "add tests" } },
  });
  client._handleStreamEvent({
    event: "step_update",
    step_update: { step_type: "call_mcp_tool", tool_name: "worker_implement", state: "DONE" },
  });

  assert.ok(isToolCallItem(started[0]));
  assert.equal(toolNameOf(started[0]), "worker_implement");
  assert.equal(toolArgsOf(started[0]).task, "add tests");
  assert.equal(completed[0].id, started[0].id, "completion must close the call that started");
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


