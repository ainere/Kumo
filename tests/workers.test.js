import "./helpers/env.js";
/**
 * workers.test.js — Worker adapters build the command line their CLI needs.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTask as runCodexWorker } from "../src/providers/workers/codex.js";
import { executeTask as runClaudeWorker } from "../src/providers/workers/claude.js";

/** A stub CLI that records its argv to `log` and prints "ok". */
function argvStub(dir, log) {
  const impl = path.join(dir, "cli.cjs");
  fs.writeFileSync(
    impl,
    `require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))); process.stdout.write("ok");`
  );
  if (process.platform === "win32") {
    const stub = path.join(dir, "codex.cmd");
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
    return stub;
  }
  const stub = path.join(dir, "codex.sh");
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  return stub;
}

test("a Codex worker switches off kumo-bridge only when a config defines it", async () => {
  // Codex filters the environment of the MCP servers it starts, so the
  // bridge's nested-call marker never reaches a bridge launched by
  // `codex exec`; the server has to be disabled on the command line. On an
  // undefined server that setting is a config error, so it must be conditional.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-codex-worker-"));
  const codexHome = path.join(root, "codex-home");
  const ws = path.join(root, "ws");
  fs.mkdirSync(codexHome);
  fs.mkdirSync(path.join(ws, ".codex"), { recursive: true });
  const log = path.join(root, "argv.json");
  const saved = { CODEX_BIN: process.env.CODEX_BIN, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEX_BIN = argvStub(root, log);
  process.env.CODEX_HOME = codexHome;
  const argv = async () => {
    await runCodexWorker({ prompt: "x", workspace: ws, permission: "read" });
    return JSON.parse(fs.readFileSync(log, "utf-8"));
  };

  try {
    assert.ok(!(await argv()).includes("mcp_servers.kumo-bridge.enabled=false"), "no config defines it");

    fs.writeFileSync(path.join(ws, ".codex", "config.toml"), 'mcp_servers.kumo-bridge.command = "node"\n');
    assert.ok((await argv()).includes("mcp_servers.kumo-bridge.enabled=false"), "the workspace config defines it");

    fs.rmSync(path.join(ws, ".codex", "config.toml"));
    fs.writeFileSync(path.join(codexHome, "config.toml"), '[mcp_servers."kumo-bridge"]\ncommand = "node"\n');
    assert.ok((await argv()).includes("mcp_servers.kumo-bridge.enabled=false"), "the global config defines it");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a read-only Claude worker cannot edit; a write task may; neither starts other MCP servers", async () => {
  // A plain `claude -p` was the only restriction before: any allow rule or
  // `defaultMode` in the user's settings let a "read-only" worker edit files.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-claude-worker-"));
  const log = path.join(root, "argv.json");
  const saved = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = argvStub(root, log);
  const argv = async (opts) => {
    await runClaudeWorker({ prompt: "x", workspace: root, ...opts });
    return JSON.parse(fs.readFileSync(log, "utf-8"));
  };
  const after = (args, flag) => args[args.indexOf(flag) + 1];

  try {
    const read = await argv({ permission: "read", model: "claude-haiku-5-5", effort: "low" });
    assert.strictEqual(after(read, "--permission-mode"), "dontAsk");
    assert.strictEqual(after(read, "--disallowedTools"), "Edit,Write,NotebookEdit");
    assert.ok(!read.includes("--dangerously-skip-permissions"));
    assert.ok(read.includes("--strict-mcp-config"));
    assert.strictEqual(after(read, "--model"), "claude-haiku-5-5");
    assert.strictEqual(after(read, "--effort"), "low");

    const write = await argv({ permission: "write" });
    assert.ok(write.includes("--dangerously-skip-permissions"));
    assert.ok(!write.includes("--disallowedTools") && !write.includes("dontAsk"));
    assert.ok(write.includes("--strict-mcp-config"));
    assert.ok(!write.includes("--effort"), "no effort flag when none is set");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
