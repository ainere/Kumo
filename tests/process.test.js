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
  pickWindowsCandidate,
  clearBinaryCache,
  SECRET_ENV_RE,
} from "../src/utils/process.js";
import { runCliWorker } from "../src/providers/workers/cli-runner.js";

test("isWindowsBatch identifies batch scripts on win32 and never elsewhere", () => {
  assert.strictEqual(isWindowsBatch("C:\\bin\\codex.cmd", "win32"), true);
  assert.strictEqual(isWindowsBatch("C:\\bin\\run.bat", "win32"), true);
  assert.strictEqual(isWindowsBatch("C:\\bin\\codex.exe", "win32"), false);
  assert.strictEqual(isWindowsBatch("codex", "win32"), false);
  assert.strictEqual(isWindowsBatch("agy", "win32"), false);

  assert.strictEqual(isWindowsBatch("C:\\bin\\codex.cmd", "linux"), false);
  assert.strictEqual(isWindowsBatch("/usr/bin/codex", "linux"), false);
});

test("quoteCmdArg leaves safe tokens bare and never emits a %NAME% pair", () => {
  assert.strictEqual(quoteCmdArg("app-server"), "app-server");
  assert.strictEqual(quoteCmdArg("--stdio"), "--stdio");
  assert.strictEqual(quoteCmdArg("a&b"), '"a&b"');
  // cmd.exe expands %NAME% even inside quotes, and on a `cmd /c` line `%%` is
  // not an escape. The quoted form must contain no %...% pair at all.
  for (const arg of ["%PATH%", "see %USERPROFILE% now", "100%", "%%"]) {
    assert.doesNotMatch(quoteCmdArg(arg), /%[^%^"]*%/, `${arg} must not leave an expandable pair`);
  }
});

/**
 * Arguments that broke, or could break, the trip through cmd.exe into a .cmd
 * shim. Each must arrive at the program unchanged.
 */
const CMD_ROUND_TRIP_CASES = [
  "coverage 100%",
  "see %USERPROFILE% dir",
  "%PATH%",
  "%%",
  "x % y % z",
  'say "hi" & calc',
  "a|b<c>d^e",
  "!x!",
  "(paren) [br]",
  "trailing\\",
  "C:\\my dir\\",
  'a\\"b',
  'q"q',
  "unicode ünï 雲",
  " ",
];

test("arguments reach a program behind a .cmd shim byte-for-byte", { skip: process.platform !== "win32" && "cmd.exe only exists on Windows" }, async () => {
  // Drive the real path: safeSpawn → cmd.exe /d /s /c → .cmd shim → node.
  // The old test compared quoteCmdArg's output to a hand-written string and
  // so certified "%%PATH%%", which cmd.exe still expands.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-argv-"));
  try {
    const echo = path.join(dir, "echo.cjs");
    fs.writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const shim = path.join(dir, "echo-args.cmd");
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${echo}" %*\r\n`);

    const proc = safeSpawn(shim, CMD_ROUND_TRIP_CASES, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => (stdout += c));
    proc.stderr.on("data", (c) => (stderr += c));
    const code = await new Promise((resolve) => proc.on("close", resolve));

    assert.strictEqual(code, 0, stderr);
    assert.deepStrictEqual(JSON.parse(stdout), CMD_ROUND_TRIP_CASES);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  const prep = prepareSpawn("x.cmd", ["a&b", "c|d", 'q"q'], {}, "win32");
  // Metacharacters stay inside a quoted run, where cmd.exe treats them as text.
  assert.ok(prep.args[3].includes('"a&b"'));
  assert.ok(prep.args[3].includes('"c|d"'));
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

test("pickWindowsCandidate skips npm's extensionless shell shim", () => {
  // Real `where.exe gemini` output on a machine with the npm-installed CLI:
  // the POSIX script is listed first, and CreateProcess cannot run it.
  const lines = [
    "C:\\Users\\u\\AppData\\Roaming\\npm\\gemini",
    "C:\\Users\\u\\AppData\\Roaming\\npm\\gemini.cmd",
  ];
  assert.strictEqual(pickWindowsCandidate(lines, ".COM;.EXE;.BAT;.CMD"), lines[1]);
  assert.strictEqual(pickWindowsCandidate(["C:\\a\\tool.ps1", "C:\\b\\tool.exe"], ".EXE;.CMD"), "C:\\b\\tool.exe");
  assert.strictEqual(pickWindowsCandidate(["C:\\a\\tool"], ".EXE;.CMD"), null);
  // PATHEXT also lists script types that CreateProcess cannot start directly.
  const defaultPathext = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
  assert.strictEqual(pickWindowsCandidate(["C:\\a\\tool.js", "C:\\a\\tool.cmd"], defaultPathext), "C:\\a\\tool.cmd");
});

test("resolveBinary finds the runnable shim for a bare npm-style name", { skip: process.platform !== "win32" && "where.exe shim layout is Windows-only" }, async () => {
  // Lay out a CLI the way npm does — extensionless script plus .cmd — and put
  // it first on PATH. Before the fix the bare name resolved to the script.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-npmbin-"));
  const name = `kumo-probe-${process.pid}`;
  fs.writeFileSync(path.join(dir, name), "#!/bin/sh\necho posix\n");
  fs.writeFileSync(path.join(dir, `${name}.cmd`), "@echo SHIM_OK\r\n");
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  clearBinaryCache();
  try {
    const resolved = resolveBinary(name);
    assert.strictEqual(resolved.toLowerCase(), path.join(dir, `${name}.cmd`).toLowerCase());

    const proc = safeSpawn(resolved, [], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout.on("data", (c) => (stdout += c));
    const code = await new Promise((resolve) => proc.on("close", resolve));
    assert.strictEqual(code, 0);
    assert.strictEqual(stdout.trim(), "SHIM_OK");
  } finally {
    process.env.PATH = savedPath;
    clearBinaryCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker timeout kills the whole process tree, not just the shim", { skip: process.platform !== "win32" && "the orphaning is a Windows-only failure" }, async () => {
  // The shim starts a long-lived grandchild (the real worker). A SIGTERM on
  // Windows killed only the shim, which then counted as exited, so the
  // delayed tree kill skipped it and the worker ran on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-orphan-"));
  const pidFile = path.join(dir, "worker.pid");
  const worker = path.join(dir, "worker.cjs");
  fs.writeFileSync(
    worker,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`
  );
  const shim = path.join(dir, "slow-worker.cmd");
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${worker}"\r\n`);

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  try {
    const res = await runCliWorker({ providerId: "test", bin: shim, args: [], workspace: dir, timeoutMs: 1500 });
    assert.strictEqual(res.timedOut, true);
    const pid = Number(fs.readFileSync(pidFile, "utf-8"));
    // taskkill is synchronous, but give the OS a moment to reap the process.
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(alive(pid), false, "the grandchild worker must not outlive the timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
