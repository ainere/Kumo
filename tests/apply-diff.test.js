import "./helpers/env.js";
/**
 * apply-diff.test.js — Applying an approved preview must apply exactly that preview.
 *
 * Each case here was a reproduced defect in the first version of
 * applyApprovedDiff: a ``` line inside the diff cut it short (and --recount
 * hid the damage), unprefixed paths were stripped to the wrong file, and
 * absolute paths were recreated inside the workspace — all reported as
 * "applied exactly".
 */

import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  applyApprovedDiff,
  extractUnifiedDiff,
  extractPreviewFiles,
  changedFilesBetween,
} from "../src/bridge/server.js";

/** A committed git workspace holding `files` (path → content). */
function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-apply-test-"));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf-8").replace(/\r\n/g, "\n");
const fence = "```";

test("a ``` line inside the diff does not cut the approved change short", () => {
  const dir = repoWith({ "README.md": "x\n" });
  try {
    const diff = [
      "--- /dev/null",
      "+++ b/docs/guide.md",
      "@@ -0,0 +1,7 @@",
      "+# Guide",
      "+",
      "+Install:",
      `+${fence}bash`,
      "+npm install",
      `+${fence}`,
      "+Done.",
      "",
    ].join("\n");
    const preview = `Proposed change:\n${fence}diff\n${diff}${fence}\nImpact: adds a guide.`;

    assert.strictEqual(extractUnifiedDiff(preview), diff, "the whole diff must be extracted");
    assert.deepStrictEqual(applyApprovedDiff(dir, preview), { ok: true });
    assert.strictEqual(read(dir, "docs/guide.md"), `# Guide\n\nInstall:\n${fence}bash\nnpm install\n${fence}\nDone.\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unprefixed diff is applied to the path it names", () => {
  // Both files have the same content: with git's default -p1 the change went
  // to the top-level index.js instead of src/index.js.
  const dir = repoWith({ "src/index.js": "old\n", "index.js": "old\n" });
  try {
    const diff = ["--- src/index.js", "+++ src/index.js", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
    assert.deepStrictEqual(applyApprovedDiff(dir, diff), { ok: true });
    assert.strictEqual(read(dir, "src/index.js"), "new\n");
    assert.strictEqual(read(dir, "index.js"), "old\n");
    assert.deepStrictEqual(extractPreviewFiles(diff), ["src/index.js"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unprefixed new file is created where the diff says", () => {
  const dir = repoWith({ "README.md": "x\n" });
  try {
    const diff = ["--- /dev/null", "+++ src/utils/helper.js", "@@ -0,0 +1 @@", "+export const h = 1;", ""].join("\n");
    assert.deepStrictEqual(applyApprovedDiff(dir, diff), { ok: true });
    assert.ok(fs.existsSync(path.join(dir, "src/utils/helper.js")));
    assert.ok(!fs.existsSync(path.join(dir, "utils/helper.js")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a diff naming an absolute or parent path is refused and writes nothing", () => {
  const dir = repoWith({ "README.md": "x\n" });
  try {
    for (const target of ["C:/Users/someone/x.txt", "/etc/x.txt", "../outside.txt"]) {
      const diff = ["--- /dev/null", `+++ ${target}`, "@@ -0,0 +1 @@", "+boom", ""].join("\n");
      const res = applyApprovedDiff(dir, diff);
      assert.strictEqual(res.ok, false, target);
      assert.match(res.reason, /outside the workspace/);
    }
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), [".git", "README.md"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a hunk whose line counts do not match its body is rejected, not recounted", () => {
  // --recount used to rewrite the header to fit a truncated body, so a
  // diff missing its tail applied "successfully".
  const dir = repoWith({ "a.txt": "1\n2\n3\n" });
  try {
    const diff = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,3 +1,3 @@", " 1", "-2", "+two", ""].join("\n");
    const res = applyApprovedDiff(dir, diff);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(read(dir, "a.txt"), "1\n2\n3\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a file dirty in both snapshots but never hashed is not reported as changed", () => {
  const pre = { files: ["big.log", "a.txt"], hashes: new Map([["a.txt", "h1"]]) };
  const post = { files: ["big.log", "a.txt", "new.txt"], hashes: new Map([["a.txt", "h2"], ["new.txt", "h3"]]) };
  assert.deepStrictEqual(changedFilesBetween(pre, post), ["a.txt", "new.txt"]);
});
