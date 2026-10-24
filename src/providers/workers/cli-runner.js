/**
 * cli-runner.js — Shared execution core for every CLI-backed worker adapter.
 *
 * All nine CLI workers previously carried their own copy of the spawn,
 * output-accumulation, timeout and kill logic. Centralizing it means the
 * credential scrub, the live-log tee, the process-tree kill, and the Windows
 * command-line workaround exist once instead of nine times.
 */

import {
  spawnWithLiveLog,
  childEnvFor,
  killProcessTree,
  stopProcessTree,
  isWindowsBatch,
} from "../../utils/process.js";

/** Hard cap on captured stdout/stderr per stream. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Default per-task execution ceiling. */
export const DEFAULT_TIMEOUT_MS = 300000;

/**
 * A composite prompt routed through a Windows `.cmd`/`.bat` shim is spliced into
 * a `cmd.exe /d /s /c` command line, where a newline terminates the command and
 * the ~8191-character limit truncates it. Such prompts must go over stdin.
 *
 * @param {string} bin
 * @param {string|null} prompt
 * @returns {boolean}
 */
export function mustUseStdinPrompt(bin, prompt) {
  if (!prompt) return false;
  return isWindowsBatch(bin) && (/[\r\n]/.test(prompt) || prompt.length > 4000);
}

/**
 * Whether a worker task may modify the workspace.
 *
 * The bridge always passes an explicit `permission`, decided per tool call:
 * read-only tools and diff previews get `"read"`; an autonomous write or an
 * approved apply gets `"write"`. Tying the write flag to the safety mode
 * instead meant an *approved* change in diff-review/interactive mode ran
 * without permission to write and could never land. The mode-based rule is
 * kept only for callers that predate `permission`.
 *
 * @param {{ permission?: "read"|"write", mode?: string, safetyMode?: string }} opts
 * @returns {boolean}
 */
export function grantsWrite({ permission, mode = "read-only", safetyMode = "autonomous" } = {}) {
  if (permission === "write") return true;
  if (permission === "read") return false;
  return mode === "workspace-write" && safetyMode === "autonomous";
}

/**
 * Render file contents the bridge inlined for workers that cannot open files.
 *
 * @param {Array<{ path: string, content: string, truncated?: boolean }>} fileContents
 * @returns {string}
 */
function renderFileContents(fileContents) {
  return fileContents
    .map(
      (f) =>
        `--- ${f.path}${f.truncated ? " (truncated)" : ""} ---\n${f.content}${f.content.endsWith("\n") ? "" : "\n"}--- end ${f.path} ---`
    )
    .join("\n\n");
}

/**
 * Build the standard composite prompt every worker sends.
 *
 * @param {Object} parts
 * @param {string} parts.prompt
 * @param {string} [parts.systemPrompt]
 * @param {boolean} [parts.previewDiff]
 * @param {string[]} [parts.files]
 * @param {Array<{ path: string, content: string, truncated?: boolean }>} [parts.fileContents]
 * @param {string} [parts.previewNote] - provider-specific diff-preview wording
 * @returns {string}
 */
export function buildCompositePrompt({
  prompt,
  systemPrompt,
  previewDiff = false,
  files = [],
  fileContents = [],
  previewNote,
}) {
  let composite = "";
  if (systemPrompt) {
    composite += `[System Instructions]\n${systemPrompt}\n\n`;
  }
  if (previewDiff) {
    composite += `[DIFF PREVIEW MODE]\n${
      previewNote || "Produce a complete unified git diff without modifying files on disk."
    }\n\n`;
  }
  if (files && files.length > 0) {
    composite += `[Relevant Files]\n${files.map((f) => `- ${f}`).join("\n")}\n\n`;
  }
  if (fileContents && fileContents.length > 0) {
    composite +=
      `[File Contents]\nYou cannot open files yourself. These are the only workspace files you can see; ` +
      `say so if they are not enough to answer.\n\n${renderFileContents(fileContents)}\n\n`;
  }
  composite += `[Task]\n${prompt}`;
  return composite;
}

/**
 * Spawn a worker CLI and collect its result.
 *
 * @param {Object} opts
 * @param {string} opts.providerId - provider id, used for the credential allowlist
 * @param {string} opts.bin - resolved executable
 * @param {string[]} opts.args - argv (must already exclude the prompt when `stdinPrompt` is set)
 * @param {string} opts.workspace
 * @param {string} [opts.label] - human name used in spawn-failure messages
 * @param {number} [opts.timeoutMs]
 * @param {string|null} [opts.liveLogPath]
 * @param {string|null} [opts.stdinPrompt] - prompt to write to the child's stdin
 * @param {Record<string,string|undefined>} [opts.extraEnv]
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runCliWorker({
  providerId,
  bin,
  args,
  workspace = process.cwd(),
  label,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  liveLogPath = null,
  stdinPrompt = null,
  extraEnv = {},
}) {
  const name = label || providerId;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const append = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_BYTES) return current;
      const remaining = MAX_OUTPUT_BYTES - current.length;
      const str = chunk.toString();
      return current + (str.length <= remaining ? str : str.slice(0, remaining));
    };

    let proc;
    try {
      proc = spawnWithLiveLog(
        bin,
        args,
        {
          cwd: workspace,
          stdio: [stdinPrompt === null ? "ignore" : "pipe", "pipe", "pipe"],
          env: childEnvFor(providerId, extraEnv),
        },
        liveLogPath
      );
    } catch (err) {
      resolve({
        ok: false,
        code: 1,
        stdout: "",
        stderr: `Failed to spawn ${name} worker '${bin}': ${err.message}`,
        timedOut: false,
      });
      return;
    }

    if (stdinPrompt !== null && proc.stdin) {
      proc.stdin.on("error", () => {
        /* the child may exit before draining stdin */
      });
      proc.stdin.end(stdinPrompt, "utf-8");
    }

    proc.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    proc.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });

    let escalation = null;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // On Windows this takes down the whole tree at once: a SIGTERM there
      // kills only the shim, which then counts as exited, so a later
      // escalation saw nothing to do and the real worker kept running.
      stopProcessTree(proc);
      escalation = setTimeout(() => killProcessTree(proc), 5000);
      escalation.unref?.();
    }, timeoutMs);

    proc.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      resolve({
        ok: code === 0,
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });

    proc.on("error", (err) => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      resolve({
        ok: false,
        code: 1,
        stdout: "",
        stderr: `Failed to spawn ${name} worker '${bin}': ${err.message}`,
        timedOut: false,
      });
    });
  });
}
