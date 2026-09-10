import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getObsidianVaultPath } from "../src/config/settings.js";
import {
  extractPreviewFiles,
  checkDiffFidelity,
  pendingPreviews,
} from "../src/bridge/server.js";
import { inspectGraph } from "../src/commands/graph.js";

test("getObsidianVaultPath prioritizes KUMO_OBSIDIAN_VAULT env var over config", () => {
  const originalEnv = process.env.KUMO_OBSIDIAN_VAULT;
  try {
    process.env.KUMO_OBSIDIAN_VAULT = "/custom/env/vault";
    const res = getObsidianVaultPath({ obsidianVault: "/custom/config/vault" });
    assert.equal(res, "/custom/env/vault");

    delete process.env.KUMO_OBSIDIAN_VAULT;
    const resConfig = getObsidianVaultPath({ obsidianVault: "/custom/config/vault" });
    assert.equal(resConfig, "/custom/config/vault");

    const resEmpty = getObsidianVaultPath({ obsidianVault: "" });
    assert.equal(resEmpty, null);
  } finally {
    if (originalEnv !== undefined) {
      process.env.KUMO_OBSIDIAN_VAULT = originalEnv;
    } else {
      delete process.env.KUMO_OBSIDIAN_VAULT;
    }
  }
});

test("extractPreviewFiles parses git diff headers and file tags", () => {
  const preview = `
[DIFF PREVIEW MODE]
I will modify the following files:
File: src/utils/helper.js

--- a/src/config.js
+++ b/src/config.js
@@ -1,3 +1,4 @@
+ export const TEST = 1;

diff --git a/src/index.js b/src/index.js
--- a/src/index.js
+++ b/src/index.js
  `;
  const files = extractPreviewFiles(preview);
  assert.ok(files.some((f) => f.includes("config.js")));
  assert.ok(files.some((f) => f.includes("index.js")));
  assert.ok(files.some((f) => f.includes("helper.js")));
});

test("checkDiffFidelity identifies matching files and divergence", () => {
  const preview = `
--- a/src/config.js
+++ b/src/config.js
@@ -1,3 +1,4 @@
+ export const TEST = 1;
  `;

  // Exact or suffix match -> no warning
  const matchResult = checkDiffFidelity(preview, ["src/config.js"]);
  assert.equal(matchResult, null);

  // Divergence -> warning generated
  const divergeResult = checkDiffFidelity(preview, ["src/config.js", "src/unexpected.js"]);
  assert.ok(divergeResult !== null);
  assert.match(divergeResult, /Preview and applied changes diverge/);
  assert.match(divergeResult, /Unexpected files modified: src\/unexpected\.js/);

  // Missing file in applied changes
  const missingResult = checkDiffFidelity(preview, ["src/other.js"]);
  assert.ok(missingResult !== null);
  assert.match(missingResult, /Preview and applied changes diverge/);
  assert.match(missingResult, /Previewed files that were not modified/);
});

test("inspectGraph detects missing vs existing graphify data", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-graph-test-"));
  try {
    const missing = inspectGraph(tmpDir);
    assert.equal(missing.exists, false);

    const graphDir = path.join(tmpDir, "graphify-out");
    fs.mkdirSync(graphDir, { recursive: true });
    const graphJson = path.join(graphDir, "graph.json");
    fs.writeFileSync(
      graphJson,
      JSON.stringify({ nodes: [{ id: "n1" }, { id: "n2" }], edges: [{ from: "n1", to: "n2" }] }),
      "utf-8"
    );

    const found = inspectGraph(tmpDir);
    assert.equal(found.exists, true);
    assert.equal(found.nodeCount, 2);
    assert.equal(found.edgeCount, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
