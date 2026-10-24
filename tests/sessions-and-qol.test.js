import "./helpers/env.js";
/**
 * sessions-and-qol.test.js — Verification tests for sessions data layer, spinner, and history.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  hashWorkspace,
  registerProject,
  listProjects,
  createChat,
  listChats,
  updateChat,
  deleteChat,
  appendTurn,
  loadTurnLog,
  generateChatTitle,
  getLiveLogDir,
  getLiveLogPath,
  setActiveLiveRun,
  getActiveLiveRun,
  clearActiveLiveRun,
  readLiveLogChunk,
  ACTIVE_RUN_MAX_AGE_MS,
} from "../src/data/sessions.js";
import { createSpinner } from "../src/utils/spinner.js";
import { loadHistory, saveHistory, cleanHistory, clearHistory } from "../src/utils/history.js";
import { isCodexModel, resolveModel } from "../src/config/settings.js";

test("hashWorkspace folds case only on case-insensitive filesystems", () => {
  const h1 = hashWorkspace("d:\\Projects\\Kumo");
  const h2 = hashWorkspace("D:\\Projects\\Kumo");
  assert.strictEqual(h1.length, 12);
  assert.match(h1, /^[0-9a-f]{12}$/);

  if (process.platform === "win32" || process.platform === "darwin") {
    assert.strictEqual(h1, h2, "Windows and macOS paths are case-insensitive");
  } else {
    assert.notStrictEqual(h1, h2, "POSIX paths are case-sensitive; folding would collide them");
  }

  assert.strictEqual(hashWorkspace("/srv/app"), hashWorkspace("/srv/app"), "hash is deterministic");
});

test("registerProject and listProjects persist and order workspaces", () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-project-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const reg = registerProject(testDir);
    assert.strictEqual(reg.path, path.resolve(testDir));

    const projects = listProjects();
    const found = projects.find((p) => path.resolve(p.path) === path.resolve(testDir));
    assert.ok(found, "Registered project should be in listProjects");
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("createChat, listChats, updateChat, and deleteChat manage chat lifecycle", () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-chat-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const chatId = createChat(testDir, {
      model: "chatgpt-6-astra",
      effort: "low",
    });
    assert.ok(chatId.startsWith("chat-"));

    let chats = listChats(testDir);
    assert.strictEqual(chats.length, 1);
    assert.strictEqual(chats[0].id, chatId);
    assert.strictEqual(chats[0].title, "New Chat");

    const updated = updateChat(testDir, chatId, { title: "Refactored Title", turns: 3 });
    assert.strictEqual(updated, true);

    chats = listChats(testDir);
    assert.strictEqual(chats[0].title, "Refactored Title");
    assert.strictEqual(chats[0].turns, 3);

    deleteChat(testDir, chatId);
    chats = listChats(testDir);
    assert.strictEqual(chats.length, 0);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("appendTurn and loadTurnLog append and retrieve turns correctly", () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-turns-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const chatId = createChat(testDir, { model: "chatgpt-6-astra" });

    appendTurn(testDir, chatId, {
      prompt: "Hello Kumo",
      responseSummary: "Hello! How can I help?",
      timestamp: 1000,
      model: "chatgpt-6-astra",
      elapsedMs: 1200,
    });

    appendTurn(testDir, chatId, {
      prompt: "Show architecture",
      responseSummary: "Here is the arch diagram.",
      timestamp: 2000,
      model: "chatgpt-6-astra",
      elapsedMs: 2300,
    });

    const turns = loadTurnLog(testDir, chatId);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].prompt, "Hello Kumo");
    assert.strictEqual(turns[1].prompt, "Show architecture");
    assert.strictEqual(turns[1].elapsedMs, 2300);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});
test("appendTurn rejects traversal chatIds and loadTurnLog skips corrupt lines", async () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-turns-evil-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    assert.throws(() => appendTurn(testDir, "../../evil", { prompt: "x" }), /Invalid chatId/);

    const chatId = createChat(testDir, { model: "chatgpt-6-astra" });
    appendTurn(testDir, chatId, { prompt: "good-1" });
    appendTurn(testDir, chatId, { prompt: "good-2" });
    assert.strictEqual(loadTurnLog(testDir, chatId).length, 2);

    const { getSessionDir } = await import("../src/data/sessions.js");
    fs.appendFileSync(path.join(getSessionDir(testDir), `${chatId}.json`), "NOT-JSON\n", "utf-8");
    const turns = loadTurnLog(testDir, chatId);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].prompt, "good-1");

    assert.throws(() => loadTurnLog(testDir, "../../evil"), /Invalid chatId/);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("generateChatTitle cleans and truncates prompt", () => {
  const shortPrompt = "Fix login issue";
  assert.strictEqual(generateChatTitle(shortPrompt), "Fix login issue");

  const longPrompt = "This is a very long prompt that explains a detailed architecture refactoring and should be truncated to fifty characters";
  const title = generateChatTitle(longPrompt);
  assert.ok(title.length <= 50);
  assert.ok(title.endsWith("..."));
});

test("createSpinner initializes and stops cleanly", () => {
  const spinner = createSpinner("Testing");
  assert.strictEqual(spinner.isActive(), false);
  spinner.start();
  assert.strictEqual(spinner.isActive(), true);
  spinner.stop();
  assert.strictEqual(spinner.isActive(), false);
});

test("saveHistory and loadHistory persist recent lines", () => {
  const testLines = ["/model", "/status", "fix unit tests"];
  saveHistory(testLines);
  const loaded = loadHistory();
  assert.ok(Array.isArray(loaded));
  assert.ok(loaded.includes("/model"));
  assert.ok(loaded.includes("fix unit tests"));
});

test("cleanHistory removes non-chat slash commands and keeps prompt queries", () => {
  const mixed = ["/model", "implement authentication", "/effort high", "/status", "fix CSS flexbox bug"];
  saveHistory(mixed);
  const cleaned = cleanHistory();
  assert.strictEqual(cleaned.includes("/model"), false);
  assert.strictEqual(cleaned.includes("/effort high"), false);
  assert.strictEqual(cleaned.includes("/status"), false);
  assert.strictEqual(cleaned.includes("implement authentication"), true);
  assert.strictEqual(cleaned.includes("fix CSS flexbox bug"), true);
});

test("clearHistory removes persistent history file", () => {
  saveHistory(["some prompt"]);
  clearHistory();
  const loaded = loadHistory();
  assert.strictEqual(loaded.length, 0);
});

test("isCodexModel distinguishes Codex vs Antigravity models correctly", () => {
  // Codex models
  assert.strictEqual(isCodexModel("gpt-6-astra"), true);
  assert.strictEqual(isCodexModel("gpt-5.6-sol"), true);
  assert.strictEqual(isCodexModel("gpt-5.5"), true);
  assert.strictEqual(isCodexModel("gpt-5.6-terra"), true);
  assert.strictEqual(isCodexModel("anything", "codex"), true);

  // Antigravity models
  assert.strictEqual(isCodexModel("gemini-3.8-flash"), false);
  assert.strictEqual(isCodexModel("gemini-3.7-flash"), false);
  assert.strictEqual(isCodexModel("claude-opus-5-5"), false);
  assert.strictEqual(isCodexModel("gpt-oss-120b"), false);
  assert.strictEqual(isCodexModel("solana-x"), false);
  assert.strictEqual(isCodexModel("lunarvim"), false);
  assert.strictEqual(isCodexModel("anything", "antigravity"), false);
  assert.strictEqual(isCodexModel("anything", "gemini"), false);
});

test("resolveModel resolves both Codex and Antigravity aliases", () => {
  assert.strictEqual(resolveModel("astra"), "gpt-6-astra");
  assert.strictEqual(resolveModel("sol"), "gpt-6.1-sol");
  assert.strictEqual(resolveModel("6.1-sol"), "gpt-6.1-sol");
  assert.strictEqual(resolveModel("flash"), "gemini-3.8-flash");
  assert.strictEqual(resolveModel("opus"), "claude-opus-5-5");
  assert.strictEqual(resolveModel("oss"), "gpt-oss-120b");
});

test("promptSelect handles non-interactive TTY fallback gracefully", async () => {
  const { promptSelect } = await import("../src/utils/model-picker.js");
  const result = await promptSelect({
    title: "Test Menu",
    items: [
      { label: "Option 1", value: "opt1" },
      { label: "Option 2", value: "opt2", isCurrent: true },
    ],
  });
  assert.strictEqual(result, null, "In non-TTY test runner, promptSelect must return null");
});

test("setActiveLiveRun, getActiveLiveRun, and clearActiveLiveRun track concurrent worker runs", () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-live-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const liveDir = getLiveLogDir(testDir);
    assert.ok(fs.existsSync(liveDir), "Live log dir should exist");

    const now = Date.now();
    const run1 = { runId: "run-1", tool: "worker_explore", timestamp: now - 2000 };
    const run2 = { runId: "run-2", tool: "worker_implement", timestamp: now };

    setActiveLiveRun(testDir, run1);
    setActiveLiveRun(testDir, run2);

    // Retrieve specific runs
    assert.strictEqual(getActiveLiveRun(testDir, "run-1").tool, "worker_explore");
    assert.strictEqual(getActiveLiveRun(testDir, "run-2").tool, "worker_implement");

    // Retrieve default (newest)
    assert.strictEqual(getActiveLiveRun(testDir).runId, "run-2");

    // Clearing one run must not disturb the other
    clearActiveLiveRun(testDir, "run-1");
    assert.strictEqual(getActiveLiveRun(testDir, "run-1"), null);
    assert.strictEqual(getActiveLiveRun(testDir, "run-2")?.tool, "worker_implement");

    clearActiveLiveRun(testDir, "run-2");
    assert.strictEqual(getActiveLiveRun(testDir), null);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("getActiveLiveRun ignores orphaned registrations left by killed processes", () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-orphan-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const stale = {
      runId: "run-stale",
      tool: "worker_explore",
      timestamp: Date.now() - (ACTIVE_RUN_MAX_AGE_MS + 5000),
    };
    setActiveLiveRun(testDir, stale);

    // An explicit lookup still resolves — the caller knows which run it wants.
    assert.strictEqual(getActiveLiveRun(testDir, "run-stale")?.tool, "worker_explore");
    // The "newest active run" lookup must not adopt it.
    assert.strictEqual(getActiveLiveRun(testDir), null);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("setActiveLiveRun and getLiveLogPath reject run ids that escape the session dir", () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-runid-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    assert.throws(() => getLiveLogPath(testDir, "../../escape"), /Invalid runId/);
    setActiveLiveRun(testDir, { runId: "../../escape", tool: "x", timestamp: Date.now() });
    const activeDir = path.join(getLiveLogDir(testDir), "active");
    const entries = fs.existsSync(activeDir) ? fs.readdirSync(activeDir) : [];
    assert.deepStrictEqual(entries, [], "no file may be created for an invalid runId");
    assert.strictEqual(getActiveLiveRun(testDir), null);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test("readLiveLogChunk streams a growing log forward from a byte offset", () => {
  const testDir = path.join(os.tmpdir(), "kumo-test-seek-" + Date.now());
  fs.mkdirSync(testDir, { recursive: true });

  try {
    const logPath = getLiveLogPath(testDir, "test-seek-run");
    assert.ok(logPath.includes("test-seek-run"));

    fs.appendFileSync(logPath, "Chunk 1: Starting exploration\n");
    const first = readLiveLogChunk(testDir, "test-seek-run", 0);
    assert.strictEqual(first.text, "Chunk 1: Starting exploration\n");

    // No new bytes yet: same offset, empty read.
    const idle = readLiveLogChunk(testDir, "test-seek-run", first.offset);
    assert.strictEqual(idle.text, "");
    assert.strictEqual(idle.offset, first.offset);

    fs.appendFileSync(logPath, "Chunk 2: Found 3 files\n");
    const second = readLiveLogChunk(testDir, "test-seek-run", first.offset);
    assert.strictEqual(second.text, "Chunk 2: Found 3 files\n");
    assert.strictEqual(second.offset, fs.statSync(logPath).size);
  } finally {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});


