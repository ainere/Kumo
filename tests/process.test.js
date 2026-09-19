import "./helpers/env.js";
/**
 * process.test.js — Verification tests for the shared spawn helpers.
 *
 * The Windows command-line logic is the product's primary platform but CI also
 * runs on Linux, so every platform-specific assertion passes an explicit
 * `platform` argument instead of branching on `process.platform` (which made
 * the Windows half dead code on every Linux runner).
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  prepareSpawn,
  isWindowsBatch,
  quoteCmdArg,
  safeSpawn,
  spawnWithLiveLog,
  childEnvFor,
  resolveBinary,
  clearBinaryCache,
  SECRET_ENV_RE,
} from "../src/utils/process.js";

test("isWindowsBatch identifies batch scripts on win32 and never elsewhere", () => {
  assert.strictEqual(isWindowsBatch("C:\\bin\\codex.cmd", "win32"), true);
  assert.strictEqual(isWindowsBatch("C:\\bin\\run.bat", "win32"), true);
  assert.strictEqual(isWindowsBatch("C:\\bin\\codex.exe", "win32"), false);
  assert.strictEqual(isWindowsBatch("codex", "win32"), false);
  assert.strictEqual(isWindowsBatch("agy", "win32"), false);

  assert.strictEqual(isWindowsBatch("C:\\bin\\codex.cmd", "linux"), false);
  assert.strictEqual(isWindowsBatch("/usr/bin/codex", "linux"), false);
});

test("quoteCmdArg quotes metacharacters and neutralizes percent expansion", () => {
  assert.strictEqual(quoteCmdArg("app-server"), "app-server");
  assert.strictEqual(quoteCmdArg("--stdio"), "--stdio");
  assert.strictEqual(quoteCmdArg("a&b"), '"a&b"');
  assert.strictEqual(quoteCmdArg("c|d"), '"c|d"');
  assert.strictEqual(quoteCmdArg("%PATH%"), '"%%PATH%%"');
  assert.strictEqual(quoteCmdArg('q"q'), '"q""q"');
});

test("quoteCmdArg refuses newlines, which cmd.exe treats as command separators", () => {
  assert.throws(() => quoteCmdArg("line1\nline2"), /newline/i);
  assert.throws(() => quoteCmdArg("line1\r\nline2"), /newline/i);
});

test("prepareSpawn routes win32 batch scripts through ComSpec with shell disabled", () => {
  const prep = prepareSpawn(
    "C:\\bin\\codex.cmd",
    ["app-server", "--stdio"],
    { shell: true, cwd: "C:\\test" },
    "win32"
  );

  assert.strictEqual(prep.options.shell, false, "shell:true must never reach spawn (DEP0190)");
  assert.ok(prep.file.toLowerCase().includes("cmd"), `expected a cmd shell, got ${prep.file}`);
  assert.deepStrictEqual(prep.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.strictEqual(prep.args.length, 4);
  assert.ok(prep.args[3].includes("C:\\bin\\codex.cmd"));
  assert.ok(prep.args[3].includes("app-server"));
  assert.ok(prep.args[3].includes("--stdio"));
  assert.strictEqual(prep.options.cwd, "C:\\test");
});

test("prepareSpawn hands cmd.exe a verbatim, outer-quoted command line", () => {
  // Without windowsVerbatimArguments, Node applies MSVCRT escaping and rewrites
  // our `"` as `\"`, which cmd.exe rejects: any binary path containing a space,
  // `(` or `~` then fails with "is not recognized as an internal or external
  // command". The outer quote pair is the wrapper `/s` strips before parsing.
  const prep = prepareSpawn("C:\\Program Files (x86)\\t\\run.cmd", ["exec"], {}, "win32");

  assert.strictEqual(prep.options.windowsVerbatimArguments, true);
  assert.ok(prep.args[3].startsWith('"'), `expected an outer quote, got ${prep.args[3]}`);
  assert.ok(prep.args[3].endsWith('"'), `expected an outer quote, got ${prep.args[3]}`);
  assert.ok(prep.args[3].includes('"C:\\Program Files (x86)\\t\\run.cmd"'));
  assert.ok(!prep.args[3].includes('\\"'), "cmd.exe does not understand backslash-escaped quotes");
});

test("prepareSpawn leaves tildes unquoted; 8.3 short paths are ordinary paths", () => {
  const prep = prepareSpawn("C:\\Users\\RUNNER~1\\t\\run.cmd", ["exec"], {}, "win32");
  assert.ok(
    prep.args[3].includes("C:\\Users\\RUNNER~1\\t\\run.cmd "),
    `path should not be quoted, got ${prep.args[3]}`
  );
});

test("prepareSpawn quotes every dangerous token it splices into the cmd line", () => {
  const prep = prepareSpawn("x.cmd", ["a&b", "c|d", "%PATH%", 'q"q'], {}, "win32");
  assert.ok(prep.args[3].includes('"a&b"'));
  assert.ok(prep.args[3].includes('"c|d"'));
  assert.ok(prep.args[3].includes('"%%PATH%%"'));
  assert.ok(prep.args[3].includes('"q""q"'));
});

test("safeSpawn runs a binary whose path needs quoting", async () => {
  // Regression: every Windows user with a space in their profile path, or a
  // tool under "C:\\Program Files (x86)", hit a spawn failure here.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo spawn~probe-"));
  try {
    let stub;
    if (process.platform === "win32") {
      stub = path.join(dir, "stub.cmd");
      fs.writeFileSync(stub, "@echo STUB_OK %1\r\n");
    } else {
      stub = path.join(dir, "stub.sh");
      fs.writeFileSync(stub, '#!/bin/sh\necho "STUB_OK $1"\n', { mode: 0o755 });
    }

    const proc = safeSpawn(stub, ["exec"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });

    const code = await new Promise((resolve) => proc.on("close", resolve));
    assert.strictEqual(code, 0, `stub failed: ${stderr.trim()}`);
    assert.strictEqual(stdout.trim(), "STUB_OK exec");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prepareSpawn passes non-batch targets through untouched on both platforms", () => {
  const exe = prepareSpawn("C:\\bin\\codex.exe", ["--version"], { shell: true }, "win32");
  assert.strictEqual(exe.file, "C:\\bin\\codex.exe");
  assert.deepStrictEqual(exe.args, ["--version"]);
  assert.strictEqual(exe.options.shell, false);

  const bare = prepareSpawn("codex", ["--version"], { shell: true }, "win32");
  assert.strictEqual(bare.file, "codex");
  assert.deepStrictEqual(bare.args, ["--version"]);

  const posix = prepareSpawn("/usr/local/bin/codex", ["app-server"], { shell: true }, "linux");
  assert.strictEqual(posix.file, "/usr/local/bin/codex");
  assert.deepStrictEqual(posix.args, ["app-server"]);
  assert.strictEqual(posix.options.shell, false);
});

test("safeSpawn executes without throwing and cleanly passes arguments", async () => {
  const proc = safeSpawn(process.execPath, ["-e", "console.log('SAFE_SPAWN_OK')"]);
  let stdout = "";

  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  const code = await new Promise((resolve) => proc.on("close", resolve));
  assert.strictEqual(code, 0);
  assert.strictEqual(stdout.trim(), "SAFE_SPAWN_OK");
});

test("spawnWithLiveLog tees stdout and stderr into the live log file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-livelog-"));
  const logPath = path.join(dir, "live-test.log");

  try {
    const proc = spawnWithLiveLog(
      process.execPath,
      ["-e", "console.log('OUT_LINE'); console.error('ERR_LINE');"],
      { stdio: ["ignore", "pipe", "pipe"] },
      logPath
    );

    let collected = "";
    proc.stdout.on("data", (c) => {
      collected += c.toString();
    });

    await new Promise((resolve) => proc.on("close", resolve));

    const logged = fs.readFileSync(logPath, "utf-8");
    assert.match(logged, /OUT_LINE/, "stdout must reach the live log");
    assert.match(logged, /ERR_LINE/, "stderr must reach the live log");
    // The caller's own listener must keep working alongside the tee.
    assert.match(collected, /OUT_LINE/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("childEnvFor strips credentials the selected provider does not need", () => {
  const saved = { ...process.env };
  process.env.OPENAI_API_KEY = "sk-secret";
  process.env.ANTHROPIC_API_KEY = "ak-secret";
  process.env.SOME_TOKEN = "tok";
  process.env.DB_PASSWORD = "pw";
  process.env.KUMO_HARMLESS = "keep-me";

  try {
    const cliEnv = childEnvFor("claude");
    assert.strictEqual(cliEnv.OPENAI_API_KEY, undefined, "CLI workers need no API keys");
    assert.strictEqual(cliEnv.ANTHROPIC_API_KEY, undefined);
    assert.strictEqual(cliEnv.SOME_TOKEN, undefined);
    assert.strictEqual(cliEnv.DB_PASSWORD, undefined);
    assert.strictEqual(cliEnv.KUMO_HARMLESS, "keep-me");
    assert.ok(cliEnv.PATH || cliEnv.Path, "PATH must survive or binaries cannot resolve");

    const apiEnv = childEnvFor("anthropic-api");
    assert.strictEqual(apiEnv.ANTHROPIC_API_KEY, "ak-secret", "its own key is allowed through");
    assert.strictEqual(apiEnv.OPENAI_API_KEY, undefined, "another provider's key is not");

    const withExtra = childEnvFor("antigravity", { GEMINI_CLI_TRUST_WORKSPACE: "true" });
    assert.strictEqual(withExtra.GEMINI_CLI_TRUST_WORKSPACE, "true");
  } finally {
    for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SOME_TOKEN", "DB_PASSWORD", "KUMO_HARMLESS"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("SECRET_ENV_RE matches credential-shaped names and not ordinary ones", () => {
  for (const name of ["OPENAI_API_KEY", "GH_TOKEN", "CLIENT_SECRET", "DB_PASSWORD", "AWS_CREDENTIAL_FILE"]) {
    assert.ok(SECRET_ENV_RE.test(name), `${name} should be treated as a secret`);
  }
  for (const name of ["PATH", "HOME", "APPDATA", "ComSpec", "TEMP", "KUMO_WORKSPACE"]) {
    assert.ok(!SECRET_ENV_RE.test(name), `${name} must not be stripped`);
  }
});

test("resolveBinary returns an existing path when found and the bare name otherwise", () => {
  clearBinaryCache();

  // node is guaranteed to be on PATH: this process is running it.
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const resolved = resolveBinary(nodeName);
  assert.ok(fs.existsSync(resolved), `expected an existing path, got ${resolved}`);
  assert.ok(path.isAbsolute(resolved), `expected an absolute path, got ${resolved}`);

  const missing = "kumo-definitely-not-a-real-binary";
  assert.strictEqual(resolveBinary(missing), missing, "unknown names fall back unchanged");

  const abs = path.join(os.tmpdir(), "already-absolute");
  assert.strictEqual(resolveBinary(abs), abs, "absolute inputs pass through");
});
