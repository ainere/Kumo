/**
 * bridge-fixture.js — A throwaway git workspace plus a stub worker CLI, shared
 * by the bridge tests and the engine integration tests.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** A preview diff that applies cleanly to the fixture's target.txt. */
export const GOOD_DIFF = ["--- a/target.txt", "+++ b/target.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

/** A preview diff whose context does not match target.txt, so git apply refuses it. */
export const STALE_DIFF = ["--- a/target.txt", "+++ b/target.txt", "@@ -1 +1 @@", "-missing", "+new", ""].join("\n");

/**
 * Build a throwaway git workspace plus a stub worker binary.
 *
 * In preview mode the stub prints `preview` (wrapped in prose and a ```diff
 * fence, as real workers do). Otherwise it follows `apply`: "fail" exits 3,
 * "write" replaces target.txt with "new" and exits 0.
 *
 * @param {{ preview?: string, apply?: "fail"|"write", reply?: string }} [behavior]
 */
export function makeFixture({ preview = GOOD_DIFF, apply = "fail", reply = "stub reply", quiet = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-mcp-"));
  const callLog = path.join(dir, "calls.jsonl");
  fs.writeFileSync(path.join(dir, "target.txt"), "old\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "calls.jsonl\nstub-impl.cjs\n*-stub.*\n");
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], {
    cwd: dir,
    stdio: "ignore",
  });

  const impl = path.join(dir, "stub-impl.cjs");
  fs.writeFileSync(
    impl,
    `const fs = require("fs");
const path = require("path");
let stdin = "";
try { stdin = fs.readFileSync(0, "utf-8"); } catch {}
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ args, stdin }) + "\\n");
if (${JSON.stringify(quiet)}) {
  // Like headless agy when a needed permission is denied: exit 0, explain on stderr.
  process.stderr.write("no output produced: a tool required a permission headless mode cannot grant");
  process.exit(0);
}
const text = args.join(" ") + stdin;
if (text.includes("DIFF PREVIEW MODE")) {
  process.stdout.write("Proposed change:\\n\`\`\`diff\\n" + ${JSON.stringify(preview)} + "\`\`\`\\nImpact: one line.");
  process.exit(0);
}
if (text.includes("worker_implement") || text.includes("[Task]")) {
  if (${JSON.stringify(apply)} === "write" && /implement|apply|replace/i.test(text)) {
    fs.writeFileSync(path.join(process.cwd(), "target.txt"), "new\\n");
    process.stdout.write("wrote target.txt");
    process.exit(0);
  }
}
if (/replace old with new|apply the diff/.test(text)) {
  process.stderr.write("stub apply failure");
  process.exit(3);
}
process.stdout.write(${JSON.stringify(reply)});
`
  );

  let stub;
  if (process.platform === "win32") {
    stub = path.join(dir, "worker-stub.cmd");
    fs.writeFileSync(stub, `@echo off\r\n"${process.execPath}" "${impl}" %*\r\n`);
  } else {
    stub = path.join(dir, "worker-stub.sh");
    fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`, { mode: 0o755 });
  }

  const calls = () =>
    fs.existsSync(callLog)
      ? fs
          .readFileSync(callLog, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  return { dir, stub, calls };
}
