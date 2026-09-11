/**
 * process.test.js — Verification tests for safeSpawn and prepareSpawn.
 */

import { test } from "node:test";
import assert from "node:assert";
import { prepareSpawn, isWindowsBatch, safeSpawn } from "../src/utils/process.js";

test("isWindowsBatch identifies Windows batch scripts and extensionless binaries", () => {
  if (process.platform === "win32") {
    assert.strictEqual(isWindowsBatch("C:\\bin\\codex.cmd"), true);
    assert.strictEqual(isWindowsBatch("C:\\bin\\run.bat"), true);
    assert.strictEqual(isWindowsBatch("codex"), true);
    assert.strictEqual(isWindowsBatch("C:\\bin\\codex.exe"), false);
    assert.strictEqual(isWindowsBatch("node.exe"), false);
  } else {
    assert.strictEqual(isWindowsBatch("/usr/bin/codex"), false);
  }
});

test("prepareSpawn strips shell: true and routes batch scripts through ComSpec without DEP0190", () => {
  if (process.platform === "win32") {
    const prepBatch = prepareSpawn("C:\\bin\\codex.cmd", ["app-server", "--stdio"], { shell: true, cwd: "C:\\test" });
    assert.strictEqual(prepBatch.options.shell, false);
    assert.ok(prepBatch.file.toLowerCase().includes("cmd.exe"));
    assert.deepStrictEqual(prepBatch.args, ["/d", "/s", "/c", "C:\\bin\\codex.cmd", "app-server", "--stdio"]);
    assert.strictEqual(prepBatch.options.cwd, "C:\\test");

    const prepExe = prepareSpawn("C:\\bin\\codex.exe", ["--version"], { shell: true });
    assert.strictEqual(prepExe.options.shell, false);
    assert.strictEqual(prepExe.file, "C:\\bin\\codex.exe");
    assert.deepStrictEqual(prepExe.args, ["--version"]);
  } else {
    const prep = prepareSpawn("/usr/local/bin/codex", ["app-server"], { shell: true });
    assert.strictEqual(prep.options.shell, false);
    assert.strictEqual(prep.file, "/usr/local/bin/codex");
    assert.deepStrictEqual(prep.args, ["app-server"]);
  }
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
