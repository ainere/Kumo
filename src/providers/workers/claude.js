/**
 * claude.js — Anthropic Claude Code worker provider adapter.
 * Runs non-interactive worker tasks using `claude -p`.
 */

import { resolveBinary } from "../../utils/process.js";
import {
  runCliWorker,
  buildCompositePrompt,
  mustUseStdinPrompt,
  grantsWrite,
  DEFAULT_TIMEOUT_MS,
} from "./cli-runner.js";

export const PROVIDER_INFO = {
  id: "claude",
  name: "Anthropic Claude Code Worker",
};

/** Effort levels `claude --effort` accepts. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Built-in tools a read-only Claude worker may not use. */
export const READ_ONLY_DENIED_TOOLS = "Edit,Write,NotebookEdit";

export function findClaudeBinary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  // npm installs this as claude.cmd on Windows; the bare name cannot be spawned.
  return resolveBinary("claude");
}

export async function executeTask(opts) {
  const {
    prompt,
    files = [],
    workspace = process.cwd(),
    model,
    systemPrompt,
    previewDiff = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    liveLogPath = null,
  } = opts;

  const bin = findClaudeBinary();
  const compositePrompt = buildCompositePrompt({ prompt, systemPrompt, previewDiff, files, fileContents: opts.fileContents });

  // Flags first, positional prompt last: `["-p", "--model", m, prompt]` makes the
  // CLI read `--model` as the value of `-p`.
  // `--strict-mcp-config` with no `--mcp-config` starts no MCP servers: a
  // worker needs none, the user's own servers each cost startup time, and a
  // globally registered kumo-bridge would let it delegate recursively.
  const args = ["--strict-mcp-config"];
  if (model) {
    args.push("--model", model);
  }
  if (opts.effort && CLAUDE_EFFORTS.includes(opts.effort)) {
    args.push("--effort", opts.effort);
  }
  if (grantsWrite(opts)) {
    args.push("--dangerously-skip-permissions");
  } else {
    // Read-only: never prompt (nobody is there to answer), deny anything not
    // pre-approved, and deny the editing tools outright — a deny rule beats
    // any allow rule in the user's settings, and the CLI flag beats a
    // `defaultMode` there. Read-only shell commands (ls, git status) still
    // run. Plan mode was tried and rejected: it writes a plan file under
    // ~/.claude/plans and asks the reader to leave plan mode.
    args.push("--permission-mode", "dontAsk", "--disallowedTools", READ_ONLY_DENIED_TOOLS);
  }

  const useStdin = mustUseStdinPrompt(bin, compositePrompt);
  args.push("-p");
  if (!useStdin) {
    args.push(compositePrompt);
  }

  return runCliWorker({
    providerId: PROVIDER_INFO.id,
    label: "Claude",
    bin,
    args,
    workspace,
    timeoutMs,
    liveLogPath,
    stdinPrompt: useStdin ? compositePrompt : null,
  });
}
