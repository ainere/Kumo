/**
 * generic-client.js — Generic orchestrator client adapter for arbitrary CLI agents.
 * Allows using any external CLI (e.g. OpenCode, CommandCode, Ollama, local LLM harnesses)
 * as the frontier Orchestrator without hardcoding.
 *
 * Each turn is one process run. Subclasses only describe the command line for
 * a turn (`buildTurn`); spawning, streaming, completion and teardown live here
 * once, so every CLI reports the end of a turn the same way.
 */

import { EventEmitter } from "node:events";
import { safeSpawn, resolveBinary, stopProcessTree } from "../../utils/process.js";

/** How much trailing stderr is kept to explain a failed turn. */
const STDERR_TAIL_CHARS = 2000;

export class GenericAppClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.command = options.command || options.provider || "agent";
    this.bin = options.bin || this.command;
    this.proc = null;
    this.activeModel = options.model || null;
    this.activeEffort = options.effort || null;
    this.workspace = options.workspace || process.cwd();
    this.isTurnActive = false;
  }

  async start() {
    return Promise.resolve();
  }

  async startThread({ workspace, model, reasoningEffort } = {}) {
    if (workspace) this.workspace = workspace;
    if (model) this.activeModel = model;
    if (reasoningEffort) this.activeEffort = reasoningEffort;
    return { ok: true };
  }

  /**
   * Describe the process for one turn. Subclasses override this.
   *
   * @param {string} prompt
   * @param {{ model?: string|null, effort?: string|null }} opts
   * @returns {{ args: string[], stdin?: string|null, env?: Record<string, string> }}
   */
  buildTurn(prompt, { model, effort } = {}) {
    const args = [];
    if (model) {
      args.push("--model", model);
    }
    if (effort) {
      args.push("--effort", effort);
    }
    args.push("-p", prompt);
    return { args };
  }

  /**
   * Hook run when a turn's process exits. Subclasses use it to keep
   * conversation state (e.g. whether a session id now exists).
   *
   * @param {boolean} _ok
   */
  afterTurn(_ok) {}

  async startTurn(prompt, { model, effort } = {}) {
    const turn = this.buildTurn(prompt, {
      model: model || this.activeModel,
      effort: effort || this.activeEffort,
    });
    return this._runTurnProcess(turn);
  }

  /**
   * Spawn one turn's process and report its end as `turn_completed`
   * (`{ ok, reason? }`). Resolves with `{ ok }` once the process exits.
   */
  _runTurnProcess({ args, stdin = null, env = {} }) {
    this.isTurnActive = true;

    return new Promise((resolve, reject) => {
      let proc;
      try {
        // npm installs these CLIs as .cmd shims; the bare name cannot be spawned.
        proc = safeSpawn(resolveBinary(this.bin), args, {
          cwd: this.workspace,
          stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            ...this.options.env,
            ...env,
          },
        });
      } catch (err) {
        this.isTurnActive = false;
        reject(err);
        return;
      }
      this.proc = proc;

      if (stdin !== null && proc.stdin) {
        proc.stdin.on("error", () => {
          /* the child may exit before draining stdin */
        });
        proc.stdin.end(stdin, "utf-8");
      }

      let stderrTail = "";
      proc.stdout?.on("data", (chunk) => {
        this.emit("delta", chunk.toString());
      });
      proc.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_CHARS);
        this.emit("stderr", text);
      });

      proc.on("close", (code) => {
        if (this.proc === proc) this.proc = null;
        this.isTurnActive = false;
        const ok = code === 0;
        this.afterTurn(ok);
        const detail = stderrTail.trim();
        this.emit(
          "turn_completed",
          ok ? { ok } : { ok, reason: `${this.command} exited with code ${code}${detail ? `: ${detail}` : ""}` }
        );
        resolve({ ok });
      });

      proc.on("error", (err) => {
        if (this.proc === proc) this.proc = null;
        this.isTurnActive = false;
        this.emit("server_error", err);
        reject(err);
      });
    });
  }

  async interruptTurn() {
    const proc = this.proc;
    this.proc = null;
    stopProcessTree(proc, "SIGINT");
    this.isTurnActive = false;
    this.emit("turn_completed", { ok: false, reason: "interrupted" });
  }

  async getRateLimits() {
    return null;
  }

  async stop() {
    const proc = this.proc;
    this.proc = null;
    stopProcessTree(proc);
  }
}
