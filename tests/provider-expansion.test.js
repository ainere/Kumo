import "./helpers/env.js";
/**
 * provider-expansion.test.js — Verification for provider expansion plan.
 * Mocks globalThis.fetch (no network). Pins: unknown-key rejection, detection
 * explicit-only behavior, 13-id registry listings, chatComplete wire formats,
 * per-call dispatch override.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setConfigValue, detectProviderForModel } from "../src/config/settings.js";
import {
  listOrchestrators,
  createOrchestratorClient,
} from "../src/providers/orchestrators/registry.js";
import { listWorkers, getWorker } from "../src/providers/workers/registry.js";
import { chatComplete, ApiError } from "../src/providers/api/api-transport.js";
import { dispatchWorkerTask, resolveWorkerTarget } from "../src/bridge/server.js";
import { OpenAIApiClient } from "../src/providers/api/openai-api-client.js";
import { AnthropicApiClient } from "../src/providers/api/anthropic-api-client.js";
import { GeminiApiClient } from "../src/providers/api/gemini-api-client.js";

const EXPECTED_ORCH_IDS = [
  "codex",
  "antigravity",
  "claude",
  "opencode",
  "commandcode",
  "copilot",
  "cursor",
  "gemini-cli",
  "ollama",
  "openai-api",
  "anthropic-api",
  "gemini-api",
  "compat-api",
];

/**
 * Run `fn` with `vars` applied to process.env, restoring them afterwards.
 *
 * Async-aware: the environment is restored only after `fn`'s promise settles.
 * The synchronous version restored it right after the callback's first
 * synchronous step, so these tests passed only because chatComplete happened
 * to read its key before its first `await`.
 */
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function mockFetchOnce(handler) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = orig;
    },
  };
}

// Real Response objects: the transport reads headers and bounds the body via
// res.text(), so a `{ json }` duck-type would pin the wrong contract.
const okJson = (data) =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const errJson = (status, statusText, data) =>
  new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });

test("setConfigValue rejects secret material by construction", () => {
  assert.throws(() => setConfigValue("openaiApiKey", "x"), /Unknown config key/);
  assert.throws(() => setConfigValue("anthropicApiKey", "x"), /Unknown config key/);
});

test("detectProviderForModel stays codex for gpt-4o unless explicit", () => {
  assert.equal(detectProviderForModel("gpt-4o"), "codex");
  assert.equal(detectProviderForModel("gpt-4o", "anthropic-api"), "anthropic-api");
});

test("listOrchestrators and listWorkers contain all 13 ids", () => {
  const orchIds = listOrchestrators().map((o) => o.id).sort();
  const workerIds = listWorkers().map((w) => w.id).sort();
  for (const id of EXPECTED_ORCH_IDS) {
    assert.ok(orchIds.includes(id), `orchestrators missing ${id}`);
  }
  // Workers use gemini as the antigravity canonical id; rest identical.
  const expectedWorkerIds = EXPECTED_ORCH_IDS.map((id) =>
    id === "antigravity" ? "gemini" : id,
  );
  for (const id of expectedWorkerIds) {
    assert.ok(workerIds.includes(id), `workers missing ${id}`);
  }
  assert.equal(orchIds.length, 13);
});

test("orchestrator factory returns API clients with null rate limits", async () => {
  const openai = createOrchestratorClient({ provider: "openai-api", model: "m" });
  assert.ok(openai instanceof OpenAIApiClient);
  assert.equal(await openai.getRateLimits(), null);
  const anthropic = createOrchestratorClient({ provider: "anthropic-api", model: "m" });
  assert.ok(anthropic instanceof AnthropicApiClient);
  const gemini = createOrchestratorClient({ provider: "gemini-api", model: "m" });
  assert.ok(gemini instanceof GeminiApiClient);
  const compat = createOrchestratorClient({ provider: "compat-api", model: "m" });
  assert.ok(compat instanceof OpenAIApiClient);
  assert.equal(compat.provider, "compat-api");
});

test("chatComplete openai-api sends Bearer to /chat/completions", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const m = mockFetchOnce(async () => okJson({ choices: [{ message: { content: "hi" } }] }));
    try {
      const res = await chatComplete({ provider: "openai-api", model: "m", prompt: "hi" });
      assert.equal(res.text, "hi");
      assert.ok(m.calls[0].url.endsWith("/chat/completions"));
      assert.equal(m.calls[0].opts.headers.Authorization, "Bearer sk-test");
      assert.ok(!("anthropic-version" in m.calls[0].opts.headers));
    } finally {
      m.restore();
    }
  });
});

test("chatComplete anthropic-api sends x-api-key + version to /v1/messages", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "ak-test" }, async () => {
    const m = mockFetchOnce(async () =>
      okJson({ content: [{ type: "text", text: "yo" }] }),
    );
    try {
      const res = await chatComplete({ provider: "anthropic-api", model: "m", prompt: "hi" });
      assert.equal(res.text, "yo");
      assert.ok(String(m.calls[0].url).endsWith("/v1/messages"));
      assert.equal(m.calls[0].opts.headers["x-api-key"], "ak-test");
      assert.equal(m.calls[0].opts.headers["anthropic-version"], "2023-06-01");
    } finally {
      m.restore();
    }
  });
});

test("chatComplete missing key throws naming the env var", async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    let err = null;
    try {
      await chatComplete({ provider: "openai-api", model: "m", prompt: "hi" });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ApiError, "expected ApiError");
    assert.match(err.message, /OPENAI_API_KEY/);
  });
});
test("chatComplete non-2xx throws ApiError with status", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-test" }, async () => {
    const m = mockFetchOnce(async () => errJson(500, "Server Error", { error: { message: "boom" } }));
    try {
      await assert.rejects(
        chatComplete({ provider: "openai-api", model: "m", prompt: "hi" }),
        (err) => err instanceof ApiError && err.status === 500 && /boom/.test(err.message),
      );
    } finally {
      m.restore();
    }
  });
});

test("dispatchWorkerTask per-call provider overrides global config and inlines file contents", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-api-ws-"));
  fs.writeFileSync(path.join(ws, "config.js"), "export const SENTINEL = 7;\n");
  try {
    await withEnv({ ANTHROPIC_API_KEY: "ak-test" }, async () => {
      const m = mockFetchOnce(async () => okJson({ content: [{ type: "text", text: "routed" }] }));
      try {
        const res = await dispatchWorkerTask({
          provider: "anthropic-api",
          prompt: "say ok",
          permission: "read",
          files: ["config.js"],
          workspace: ws,
          toolName: "worker_explore",
          model: "x",
          systemPrompt: "s",
        });
        assert.equal(res.ok, true);
        assert.equal(res.stdout, "routed");
        assert.ok(String(m.calls[0].url).includes("/v1/messages"));
        // An API worker has no filesystem: it must be sent the contents, not just the path.
        assert.match(String(m.calls[0].opts.body), /export const SENTINEL = 7;/);
      } finally {
        m.restore();
      }
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("dispatchWorkerTask refuses tasks a text-only worker cannot do, without calling it", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "ak-test" }, async () => {
    const m = mockFetchOnce(async () => okJson({ content: [{ type: "text", text: "invented" }] }));
    try {
      const noFiles = await dispatchWorkerTask({
        provider: "anthropic-api",
        prompt: "explore the repo",
        permission: "read",
        files: [],
        workspace: process.cwd(),
        toolName: "worker_explore",
      });
      assert.equal(noFiles.ok, false);
      assert.equal(noFiles.refused, true);
      assert.match(noFiles.stderr, /cannot open workspace files/);

      const write = await dispatchWorkerTask({
        provider: "anthropic-api",
        prompt: "implement it",
        permission: "write",
        files: ["README.md"],
        workspace: process.cwd(),
        toolName: "worker_implement",
      });
      assert.equal(write.refused, true);
      assert.match(write.stderr, /cannot modify files/);
      assert.equal(m.calls.length, 0, "no request may be made for a refused task");
    } finally {
      m.restore();
    }
  });
});

test("worker model and effort come from config only for the configured provider", () => {
  const config = { workerProvider: "antigravity", workerModel: "gemini-3.8-flash", workerEffort: "high" };
  const onConfigured = resolveWorkerTarget({}, config);
  assert.deepEqual(
    { provider: onConfigured.provider, model: onConfigured.model, effort: onConfigured.effort },
    { provider: "antigravity", model: "gemini-3.8-flash", effort: "high" }
  );
  // A per-call override to another CLI must not inherit a model id it cannot run.
  const override = resolveWorkerTarget({ provider: "claude" }, config);
  assert.equal(override.provider, "claude");
  assert.equal(override.model, undefined);
  assert.equal(override.effort, undefined);
  // The `gemini` alias is the configured provider, so it keeps the model.
  assert.equal(resolveWorkerTarget({ provider: "gemini" }, config).model, "gemini-3.8-flash");
});

test("API workers expose executeTask and map errors without network", async () => {
  for (const id of ["openai-api", "anthropic-api", "gemini-api", "compat-api"]) {
    const w = getWorker(id);
    assert.equal(typeof w.executeTask, "function", `${id} must have executeTask`);
  }
  await withEnv(
    { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
    async () => {
      const w = getWorker("anthropic-api");
      const res = await w.executeTask({ prompt: "hi", files: [], model: "m" });
      assert.equal(res.ok, false);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /ANTHROPIC_API_KEY/);
      assert.equal(res.timedOut, false);
    },
  );
});
