/**
 * codex.js — OpenAI Codex worker provider adapter.
 * Runs non-interactive worker tasks using `codex exec`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCodexBinary } from "../orchestrators/codex.js";
import {
  runCliWorker,
  buildCompositePrompt,
  mustUseStdinPrompt,
  grantsWrite,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "codex",
  name: "OpenAI Codex Worker",
};

/**
 * Whether a Codex config that `codex exec` will load defines the kumo-bridge
 * MCP server — the global one (as older Kumo versions wrote it) or the
 * workspace's (as `kumo init` writes it).
 *
 * @param {string} workspace
 * @returns {boolean}
 */
export function codexConfigDefinesBridge(workspace) {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  for (const file of [path.join(home, "config.toml"), path.join(workspace, ".codex", "config.toml")]) {
    try {
      // Bare (`mcp_servers.kumo-bridge.command`, `[mcp_servers.kumo-bridge]`)
      // or quoted (`[mcp_servers."kumo-bridge"]`) key.
      if (/mcp_servers\.(?:"kumo-bridge"|kumo-bridge(?![\w-]))/.test(fs.readFileSync(file, "utf-8"))) return true;
    } catch {
      /* no such config */
    }
  }
  return false;
}

const PREVIEW_NOTE =
  "You are running in read-only diff preview mode. DO NOT modify any files on disk.\n" +
  "Carefully analyze the workspace and produce a complete unified git diff (--- a/... +++ b/...) " +
  "of the exact changes you propose to make, followed by an impact summary.";

/**
 * Execute a bounded worker task using Codex CLI.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - Task instructions
 * @param {string} [opts.mode] - 'read-only' or 'workspace-write'
 * @param {string[]} [opts.files] - Optional list of relevant files
 * @param {string} [opts.workspace] - Target directory
 * @param {string} [opts.model] - Specific model ID override
 * @param {string} [opts.effort] - Specific reasoning effort override
 * @param {string} [opts.systemPrompt] - System prompt instructions
 * @param {boolean} [opts.previewDiff] - Whether to enforce read-only diff generation
 * @param {number} [opts.timeoutMs] - Execution timeout
 * @param {string} [opts.liveLogPath] - File to tee raw output into
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function executeTask(opts) {
  const {
    prompt,
    files = [],
    workspace = process.cwd(),
    model,
    effort,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findCodexBinary();
  const compositePrompt = buildCompositePrompt({
    prompt,
    systemPrompt,
    previewDiff,
    files,
    previewNote: PREVIEW_NOTE,
  });

  // The sandbox is the only thing that makes a read-only task read-only, and
  // the only thing that lets an approved write land; leaving it unset meant
  // both depended on whatever the user's own Codex config defaulted to.
  const args = ["exec", "--ephemeral", "--sandbox", grantsWrite(opts) ? "workspace-write" : "read-only"];
  if (model) {
    args.push("--model", model);
  }
  if (effort) {
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }
  // A worker must not reach the bridge that launched it: with write access it
  // could spawn workers recursively. The bridge's own nested-call guard relies
  // on an environment variable, and Codex starts MCP servers with a filtered
  // environment, so the server is switched off here instead. Only when a
  // config defines it — `enabled=false` on an undefined server is a config
  // error ("invalid transport") that stops codex from starting at all.
  if (codexConfigDefinesBridge(workspace)) {
    args.push("-c", "mcp_servers.kumo-bridge.enabled=false");
  }

  // `codex exec -` reads the prompt from stdin. Only used when argv cannot carry
  // it safely (Windows .cmd shim), so the working POSIX path is unchanged.
  const useStdin = mustUseStdinPrompt(bin, compositePrompt);
  args.push(useStdin ? "-" : compositePrompt);

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Codex",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: useStdin ? compositePrompt : null,
  });
}
