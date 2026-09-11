/**
 * generic-client.js — Generic orchestrator client adapter for arbitrary CLI agents.
 * Allows using any external CLI (e.g. OpenCode, CommandCode, Ollama, local LLM harnesses)
 * as the frontier Orchestrator without hardcoding.
 */

import { EventEmitter } from "node:events";
import { safeSpawn } from "../../utils/process.js";

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

  async startTurn(prompt, { model, effort } = {}) {
    this.isTurnActive = true;
    const turnModel = model || this.activeModel;
    const turnEffort = effort || this.activeEffort;

    const args = [];
    if (turnModel) {
      args.push("--model", turnModel);
    }
    if (turnEffort) {
      args.push("--effort", turnEffort);
    }
    args.push("-p", prompt);

    return new Promise((resolve, reject) => {
      try {
        this.proc = safeSpawn(this.bin, args, {
          cwd: this.workspace,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            ...this.options.env,
          },
        });
      } catch (err) {
        this.isTurnActive = false;
        return reject(err);
      }

      this.proc.stdout?.on("data", (chunk) => {
        this.emit("delta", chunk.toString());
      });

      this.proc.stderr?.on("data", (chunk) => {
        this.emit("stderr", chunk.toString());
      });

      this.proc.on("close", (code) => {
        this.isTurnActive = false;
        this.emit("turn_completed");
        resolve({ ok: code === 0 });
      });

      this.proc.on("error", (err) => {
        this.isTurnActive = false;
        this.emit("server_error", err);
        reject(err);
      });
    });
  }

  async interruptTurn() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGINT");
      } catch {
        /* ignore */
      }
    }
    this.isTurnActive = false;
    this.emit("turn_completed");
  }

  async getRateLimits() {
    return null;
  }

  async stop() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }
}
