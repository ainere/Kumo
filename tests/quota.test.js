import "./helpers/env.js";
/**
 * quota.test.js — Antigravity usage parsing and the quota checks built on it.
 *
 * The usage text below is real `agy -p /usage` output (agy 1.2.7). Every
 * percentage in it is what is *remaining*.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAgyUsage, checkAgyHealth } from "../src/bridge/agy-runner.js";
import { AgyAppClient } from "../src/providers/orchestrators/agy-client.js";

const REAL_USAGE = [
  "Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-29T05:43:01Z",
  "Gemini Models\tFive Hour Limit Remaining\t97%\t2026-10-24T09:32:57Z",
  "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-31T07:23:14Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-24T12:23:14Z",
  "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t83%\t2026-10-25T19:12:37Z",
  "",
].join("\n");

/** Point AGY_BIN at a stub that logs its argv and prints `stdout`. */
async function withAgyStub(stdout, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-agy-usage-"));
  const log = path.join(dir, "argv.log");
  const impl = path.join(dir, "agy.cjs");
  fs.writeFileSync(
    impl,
    `require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
      `process.stdout.write(${JSON.stringify(stdout)});\n`
  );
  const stub = process.platform === "win32" ? path.join(dir, "agy.cmd") : path.join(dir, "agy.sh");
  if (process.platform === "win32") {
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
  } else {
    fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  }
  const saved = process.env.AGY_BIN;
  process.env.AGY_BIN = stub;
  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  try {
    return await fn(calls);
  } finally {
    if (saved === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parseAgyUsage reads family limits and ignores a later per-model row", () => {
  const usage = parseAgyUsage(REAL_USAGE);
  assert.strictEqual(usage.geminiWeeklyPercent, 99, "the Gemini 4 Argon row (83%) must not replace the family limit");
  assert.strictEqual(usage.gemini5HourPercent, 97);
  assert.strictEqual(usage.claudeGptWeeklyPercent, 100);
  assert.strictEqual(usage.claudeGpt5HourPercent, 100);
  assert.strictEqual(usage.geminiWeeklyResetIso, "2026-10-29T05:43:01Z");
  assert.strictEqual(usage.rawItems.length, 5, "every row stays available, the per-model one included");
});

test("parseAgyUsage falls back to a per-model row when no family row exists", () => {
  const usage = parseAgyUsage("Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t83%\t2026-10-25T19:12:37Z\n");
  assert.strictEqual(usage.geminiWeeklyPercent, 83);
});

test("parseAgyUsage returns null for output it cannot read", () => {
  assert.strictEqual(parseAgyUsage(""), null);
  assert.strictEqual(parseAgyUsage("Please log in to continue.\n"), null);
});

test("the Antigravity orchestrator reports agy's percentage as remaining, not used", async () => {
  await withAgyStub(REAL_USAGE, async () => {
    const client = new AgyAppClient({ model: "gemini-3.8-flash" });
    const limits = await client.getRateLimits();
    assert.strictEqual(limits.remainingPercent, 99);
    assert.strictEqual(limits.usedPercent, 1);
  });
});

test("checkAgyHealth asks agy for usage only; it never sends a prompt that costs quota", async () => {
  await withAgyStub(REAL_USAGE, async (calls) => {
    const health = await checkAgyHealth();
    assert.strictEqual(health.installed, true);
    assert.strictEqual(health.authenticated, true);
    assert.deepStrictEqual(calls(), [["-p", "/usage"]]);
  });
});

test("checkAgyHealth reuses a usage result it is given instead of spawning again", async () => {
  await withAgyStub(REAL_USAGE, async (calls) => {
    const health = await checkAgyHealth({ usage: null });
    assert.strictEqual(health.installed, true);
    assert.strictEqual(health.authenticated, false, "no usage data means not logged in");
    assert.deepStrictEqual(calls(), []);
  });
});

test("the quota monitor asks agy only when a role uses Antigravity, at most once per interval", async () => {
  const { QuotaMonitor } = await import("../src/core/quota-monitor.js");
  let agyCalls = 0;
  const settings = { orchestratorProvider: "codex", workerProvider: "codex" };
  const monitor = new QuotaMonitor({
    getClient: () => ({ getRateLimits: async () => ({ remainingPercent: 80 }) }),
    getSettings: () => settings,
    fetchAntigravityUsage: async () => {
      agyCalls++;
      return { geminiWeeklyPercent: 99 };
    },
    useCache: false,
  });

  const first = await monitor.refresh();
  assert.strictEqual(first.orchestrator.remainingPercent, 80);
  assert.strictEqual(agyCalls, 0, "no Antigravity role, no agy spawn");

  settings.workerProvider = "antigravity";
  await monitor.refresh();
  await monitor.refresh();
  assert.strictEqual(agyCalls, 1, "within the interval agy is not asked again");
  assert.strictEqual(monitor.snapshot().antigravity.geminiWeeklyPercent, 99);

  await monitor.refresh({ force: true });
  assert.strictEqual(agyCalls, 2, "an explicit /status or /refresh asks anyway");

  settings.workerProvider = "claude";
  assert.strictEqual(monitor.snapshot().antigravity, null, "Antigravity figures are hidden once no role uses it");
});
