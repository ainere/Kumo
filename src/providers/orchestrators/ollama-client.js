/**
 * ollama-client.js — Orchestrator client adapter for Ollama local runner (`ollama`).
 */

import { GenericAppClient } from "./generic-client.js";
import { safeSpawn } from "../../utils/process.js";

export class OllamaAppClient extends GenericAppClient {
  constructor(options = {}) {
    super({
      ...options,
      command: "ollama",
      bin: options.bin || process.env.OLLAMA_BIN || "ollama",
    });
  }

  async startTurn(prompt, { model, effort } = {}) {
    this.isTurnActive = true;
    const turnModel = model || this.activeModel || "llama3.1";
    void effort; // ollama run takes no --effort flag; effort stays a no-op.

    const args = ["run", turnModel, prompt];

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
