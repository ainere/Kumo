/**
 * env.js — Test sandbox. MUST be the first import of every test file.
 *
 * Kumo resolves its state directory lazily through `kumoHome()`, so setting
 * `KUMO_HOME` here (before any test body runs) redirects every config, session,
 * history, and quota write into a throwaway directory. Without this the suite
 * rewrites the developer's real `~/.kumo`.
 *
 * `KUMO_NO_SYNC` stops `setConfigValue`/`applyPreset` from writing provider
 * configs into the repository working tree. A test that specifically exercises
 * `syncAgentConfigs` should `delete process.env.KUMO_NO_SYNC` for its duration.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_KUMO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-test-"));

process.env.KUMO_HOME = TEST_KUMO_HOME;
process.env.KUMO_NO_SYNC = "1";

process.on("exit", () => {
  try {
    fs.rmSync(TEST_KUMO_HOME, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
