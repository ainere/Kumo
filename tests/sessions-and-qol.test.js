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
} from "../src/data/sessions.js";
import { createSpinner } from "../src/utils/spinner.js";
import { loadHistory, saveHistory, cleanHistory, clearHistory } from "../src/utils/history.js";
import { isCodexModel, resolveWorkerModel } from "../src/config/settings.js";

test("hashWorkspace generates deterministic 12-char hex hash", () => {
  const h1 = hashWorkspace("d:\\Projects\\Kumo");
  const h2 = hashWorkspace("D:\\Projects\\Kumo");
  assert.strictEqual(h1, h2, "Should be case-insensitive for workspace paths");
  assert.strictEqual(h1.length, 12);
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
  assert.strictEqual(isCodexModel("chatgpt-6-astra"), true);
  assert.strictEqual(isCodexModel("chatgpt-5.6-sol"), true);
  assert.strictEqual(isCodexModel("gpt-5.5"), true);
  assert.strictEqual(isCodexModel("gpt-5.6-terra"), true);
  assert.strictEqual(isCodexModel("anything", "codex"), true);

  // Antigravity models
  assert.strictEqual(isCodexModel("gemini-3.8-flash"), false);
  assert.strictEqual(isCodexModel("gemini-3.7-flash"), false);
  assert.strictEqual(isCodexModel("claude-opus-4-6-thinking"), false);
  assert.strictEqual(isCodexModel("gpt-oss-120b"), false);
  assert.strictEqual(isCodexModel("anything", "antigravity"), false);
  assert.strictEqual(isCodexModel("anything", "gemini"), false);
});

test("resolveWorkerModel resolves both Codex and Antigravity aliases", () => {
  assert.strictEqual(resolveWorkerModel("astra"), "chatgpt-6-astra");
  assert.strictEqual(resolveWorkerModel("sol"), "chatgpt-5.6-sol");
  assert.strictEqual(resolveWorkerModel("gpt-5"), "gpt-5.5");
  assert.strictEqual(resolveWorkerModel("flash"), "gemini-3.8-flash");
  assert.strictEqual(resolveWorkerModel("opus"), "claude-opus-4-6-thinking");
  assert.strictEqual(resolveWorkerModel("oss"), "gpt-oss-120b");
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

