import "./helpers/env.js";
/**
 * repl-e2e.test.js — The interactive session, driven end to end over pipes.
 *
 * Runs the real `kumo start --here` against a stub orchestrator CLI (the
 * Ollama adapter pointed at a script through OLLAMA_BIN). Unit tests of the
 * session store could not catch that every saved turn had an empty response:
 * the REPL read the answer from a buffer its own event listener had already
 * cleared. Only running the REPL shows it.
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const kumoBin = path.resolve(__dirname, "../bin/kumo.js");

/** Write an executable stub that runs `script` with node. */
function writeStub(dir, name, script) {
  const impl = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(impl, script);
  if (process.platform === "win32") {
    const stub = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
    return stub;
  }
  const stub = path.join(dir, `${name}.sh`);
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  return stub;
}

test("a completed turn is saved with the orchestrator's response", { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-repl-"));
  const home = path.join(root, "home");
  const ws = path.join(root, "workspace");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(ws);
  fs.mkdirSync(bin);

  // `ollama run <model> <prompt>` → a recognizable answer that echoes the prompt.
  const orchestrator = writeStub(
    bin,
    "fake-ollama",
    'process.stdout.write("ANSWER-123 for: " + process.argv.slice(4).join(" ") + "\\n");'
  );
  // Quota probes run `agy -p /usage`; make them fail fast instead of calling a real CLI.
  const agy = writeStub(bin, "fake-agy", "process.exit(1);");

  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({
      orchestratorProvider: "ollama",
      orchestratorModel: "llama3.1",
      reasoningEffort: "low",
      workerProvider: "codex",
      workerModel: "chatgpt-6-astra",
      safetyMode: "autonomous",
    })
  );

  const child = spawn(process.execPath, [kumoBin, "start", "--here", "-d", ws], {
    cwd: ws,
    env: {
      ...process.env,
      KUMO_HOME: home,
      KUMO_NO_SYNC: "1",
      KUMO_HERE: "1",
      OLLAMA_BIN: orchestrator,
      AGY_BIN: agy,
      CODEX_BIN: agy,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = new Promise((resolve) => child.on("close", resolve));

  const waitFor = async (pattern, label) => {
    const deadline = Date.now() + 20000;
    while (!pattern.test(output)) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; output so far:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  try {
    await waitFor(/kumo/, "the prompt");
    child.stdin.write("hello world\n");
    await waitFor(/Completed in/, "the turn to complete");
    child.stdin.write("/save transcript.md\n");
    await waitFor(/Session saved/, "the transcript export");
    child.stdin.write("/exit\n");
    await exited;

    const sessions = path.join(home, "sessions");
    const [hashDir] = fs.readdirSync(sessions);
    const logFile = fs.readdirSync(path.join(sessions, hashDir)).find((f) => /^chat-.*\.json$/.test(f));
    const turns = fs
      .readFileSync(path.join(sessions, hashDir, logFile), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].prompt, "hello world");
    assert.match(turns[0].responseSummary || "", /ANSWER-123 for: hello world/, "the response must be saved");

    const markdown = fs.readFileSync(path.join(ws, "transcript.md"), "utf-8");
    assert.match(markdown, /\*\*Response:\*\*\n\nANSWER-123 for: hello world/);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
