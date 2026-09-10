/**
 * cli.test.js — Automated test for CLI command resolution and Codex invocation generator.
 */

import { test } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { buildCodexInvocation, findCodexBinary } from "../src/utils/codex-launcher.js";
import { loadConfig, setConfigValue } from "../src/config/settings.js";

test("findCodexBinary finds the local Codex executable", () => {
  const bin = findCodexBinary();
  assert.ok(bin && bin.length > 0, "Expected a valid binary path or name");
});

test("buildCodexInvocation correctly targets an external workspace", () => {
  const targetDir = "d:/Projects/MySampleApp";
  const { bin, args, env } = buildCodexInvocation({
    workspace: targetDir,
    nonInteractive: false,
  });

  assert.ok(bin, "Binary must be resolved");
  assert.ok(args.includes("-C"), "Args must include -C flag");
  assert.ok(args.includes(path.resolve(targetDir)), "Args must include resolved workspace");

  const modelArg = args.find((a) => a.startsWith('model='));
  assert.ok(modelArg, "Must specify model override");

  const mcpArgs = args.filter((a) => a.includes("mcp_servers.gemini-bridge"));
  assert.ok(mcpArgs.length >= 2, "Must register mcp_servers.gemini-bridge command and args");

  assert.strictEqual(env.ORCHESTRATOR_WORKSPACE, path.resolve(targetDir));
  assert.strictEqual(env.KUMO_WORKSPACE, path.resolve(targetDir));
});

test("buildCodexInvocation sets exec subcommand for non-interactive mode", () => {
  const { args } = buildCodexInvocation({
    workspace: "d:/Projects/MySampleApp",
    nonInteractive: true,
    prompt: "inspect the codebase",
  });

  assert.strictEqual(args[0], "exec");
  assert.ok(args.includes("inspect the codebase"));
});
