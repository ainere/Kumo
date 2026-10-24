import "./helpers/env.js";
/**
 * desktop-engine.test.js — The engine pieces the desktop app relies on,
 * tested without Electron: the command router the renderer talks through,
 * desktop preferences, and how the bridge is launched from inside Electron.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionManager } from "../src/core/session-manager.js";
import { createCommandRouter } from "../src/core/commands.js";
import { loadPrefs, savePrefs, DEFAULT_PREFS } from "../src/core/prefs.js";
import { nodeCommand, RUN_AS_NODE_ENV } from "../src/core/node-command.js";
import { loadConfig } from "../src/config/settings.js";
import { kumoHome } from "../src/config/paths.js";

function fakeClient() {
  const c = new EventEmitter();
  c.start = async () => {};
  c.startThread = async () => {};
  c.startTurn = async () => {
    setImmediate(() => {
      c.emit("delta", "done");
      c.emit("turn_completed", { ok: true });
    });
    return {};
  };
  c.interruptTurn = async () => {};
  c.stop = async () => {};
  return c;
}

function makeRouter() {
  const manager = new SessionManager({
    defaults: () => ({ ...loadConfig(), orchestratorProvider: "codex", orchestratorModel: "gpt-6-astra" }),
    sessionOptions: { quotas: false, ipc: false, createClient: () => fakeClient() },
  });
  return { manager, run: createCommandRouter(manager) };
}

test("the router rejects unknown commands and arguments outside their schema", async () => {
  const { manager, run } = makeRouter();
  try {
    await assert.rejects(run("fs.delete", {}), /Unknown command 'fs\.delete'/);
    await assert.rejects(run("toString", {}), /Unknown command/, "inherited object keys are not commands");
    await assert.rejects(run("session.send", { sessionId: "x" }), /prompt/);
    await assert.rejects(run("session.send", { sessionId: "x", prompt: "hi", extra: 1 }), /extra|Unrecognized/);
    await assert.rejects(run("session.send", { sessionId: "missing", prompt: "hi" }), /No session 'missing'/);
    await assert.rejects(run("prefs.set", { patch: { mode: "neon" } }), /mode/);
  } finally {
    await manager.closeAll();
  }
});

test("a renderer can create a session, run a turn, and read the chat back", async () => {
  const { manager, run } = makeRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-desktop-"));
  try {
    const snap = await run("session.create", { workspace: ws });
    assert.strictEqual(snap.workspace, path.resolve(ws));
    assert.strictEqual(snap.busy, false);
    assert.strictEqual(manager.get(snap.id).interactive, true, "the desktop has a human at the controls");

    const outcome = await run("session.send", { sessionId: snap.id, prompt: "hello" });
    assert.strictEqual(outcome.ok, true);
    const log = await run("session.turnLog", { sessionId: snap.id });
    assert.strictEqual(log[0].responseSummary, "done");
    assert.ok((await run("session.listChats", { sessionId: snap.id })).some((c) => c.id === snap.chatId));
    assert.ok((await run("projects.list", {})).some((p) => p.path === path.resolve(ws)));

    await run("session.stop", { sessionId: snap.id });
    assert.strictEqual(manager.get(snap.id), null);
  } finally {
    await manager.closeAll();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("desktop preferences save, merge, and fall back to defaults value by value", () => {
  fs.rmSync(path.join(kumoHome(), "desktop.json"), { force: true });
  assert.deepStrictEqual(loadPrefs(), DEFAULT_PREFS);
  savePrefs({ mode: "dark", scene: "stars" });
  assert.strictEqual(loadPrefs().mode, "dark");
  assert.strictEqual(loadPrefs().dock, "right", "untouched keys keep their defaults");

  fs.writeFileSync(path.join(kumoHome(), "desktop.json"), JSON.stringify({ mode: "neon", dock: "bottom" }));
  const prefs = loadPrefs();
  assert.strictEqual(prefs.mode, "system", "an invalid value falls back to its default");
  assert.strictEqual(prefs.dock, "bottom", "valid values in the same file are kept");
  assert.throws(() => savePrefs({ glassBlur: 400 }));
});

test("inside Electron the bridge runs as node, and workspace files prefer a real node", () => {
  assert.deepStrictEqual(nodeCommand({ electron: false, execPath: "/usr/bin/node" }), { command: "/usr/bin/node", env: {} });

  const inApp = nodeCommand({ electron: true, execPath: "C:\\Kumo\\Kumo.exe" });
  assert.strictEqual(inApp.command, "C:\\Kumo\\Kumo.exe");
  assert.strictEqual(inApp.env[RUN_AS_NODE_ENV], "1", "without it the orchestrator would open the app again");

  const persistent = nodeCommand({ electron: true, execPath: "C:\\Kumo\\Kumo.exe", persistent: true, findNode: () => "C:\\node\\node.exe" });
  assert.deepStrictEqual(persistent, { command: "C:\\node\\node.exe", env: {} });

  const noNode = nodeCommand({ electron: true, execPath: "C:\\Kumo\\Kumo.exe", persistent: true, findNode: () => null });
  assert.strictEqual(noNode.env[RUN_AS_NODE_ENV], "1", "with no node on PATH, Electron-as-node is the fallback");
});
