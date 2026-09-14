/**
 * gemini-cli-client.js — Orchestrator client adapter for the standalone
 * Gemini CLI (`gemini`), distinct from the `agy` binary used by Antigravity.
 */

import { GenericAppClient } from "./generic-client.js";
import { safeSpawn } from "../../utils/process.js";

export class GeminiCliAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "gemini-cli",
      bin: options.bin || process.env.GEMINI_BIN || "gemini",
    });
  }

  async startTurn(prompt, { model, effort } = {}) {
    this.isTurnActive = true;
    const turnModel = model || this.activeModel;

    const args = ["-p", prompt];
    if (turnModel) {
      args.push("-m", turnModel);
    }
    void effort; // gemini CLI takes no --effort flag; effort stays a no-op.

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
}
