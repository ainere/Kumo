/**
 * codex-client.js — Headless JSON-RPC client for Codex app-server.
 *
 * Communicates with `codex app-server --stdio` in the background,
 * keeping the parent terminal completely clean while providing streaming deltas,
 * live rate limit snapshots, and tool event notifications.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCodexBinary } from "./codex.js";
import { formatPlanType, formatResetTime } from "../../utils/ui.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class CodexAppClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bin = options.bin || findCodexBinary();
    this.proc = null;
    this.nextId = 1;
    this.pendingRequests = new Map();
    this.buffer = "";
    this.threadId = null;
    this.activeTurnId = null;
    this.rateLimits = null;
  }

  /**
   * Start the background `codex app-server --stdio` process.
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.bin, ["app-server", "--stdio"], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          env: {
            ...process.env,
            ...this.options.env,
          },
        });
      } catch (err) {
        return reject(new Error(`Failed to spawn Codex app-server at '${this.bin}': ${err.message}`));
      }

      this.proc.stdout.on("data", (chunk) => this._handleStdout(chunk));
      this.proc.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        // Emit for debug if needed, but don't pollute terminal
        this.emit("stderr", text);
      });

      this.proc.on("error", (err) => {
        this.emit("error", err);
        reject(err);
      });

      this.proc.on("close", (code) => {
        this.emit("close", code);
        this.proc = null;
      });

      // Send initialize handshake
      this.request("initialize", {
        clientInfo: { name: "kumo", version: "1.0.0" },
        capabilities: {},
      })
        .then((res) => {
          this.emit("initialized", res);
          resolve(res);
        })
        .catch(reject);
    });
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method, params = {}) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("Codex app-server is not running or stdin is closed.");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex JSON-RPC request '${method}' (id ${id}) timed out after 30s`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.proc.stdin.write(payload);
    });
  }

  /**
   * Send a JSON-RPC notification (no reply expected).
   */
  notify(method, params = {}) {
    if (!this.proc || !this.proc.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc.stdin.write(payload);
  }

  /**
   * Query current account rate limits and parse into a normalized status object.
   */
  async getRateLimits() {
    const res = await this.request("account/rateLimits/read");
    const snapshot = res?.rateLimits || {};
    const primary = snapshot.primary || null;
    const secondary = snapshot.secondary || null;
    const planType = snapshot.planType || null;
    const credits = res?.rateLimitResetCredits || null;

    const normalized = {
      raw: res,
      planType: formatPlanType(planType),
      rawPlan: planType,
      usedPercent: primary?.usedPercent ?? 0,
      remainingPercent: Math.max(0, 100 - (primary?.usedPercent ?? 0)),
      resetsAt: primary?.resetsAt ?? null,
      resetFormatted: formatResetTime(primary?.resetsAt),
      windowMinutes: primary?.windowDurationMins ?? null,
      creditsAvailable: credits?.availableCount ?? 0,
      credits: credits?.credits ?? [],
      secondary: secondary
        ? {
            usedPercent: secondary.usedPercent,
            resetsAt: secondary.resetsAt,
            resetFormatted: formatResetTime(secondary.resetsAt),
          }
        : null,
    };

    this.rateLimits = normalized;
    return normalized;
  }

  /**
   * Initialize a thread with workspace, model, reasoning effort, and Gemini MCP server.
   */
  async startThread(opts = {}) {
    const workspace = path.resolve(opts.workspace || process.cwd());
    const normalizedWorkspace = workspace.replace(/\\/g, "/");
    const bridgeScript = path.resolve(__dirname, "../../bridge/server.js").replace(/\\/g, "/");

    const configOverrides = {
      model: opts.model || "chatgpt-6-astra",
      model_reasoning_effort: opts.reasoningEffort || "low",
      mcp_servers: {
        "gemini-bridge": {
          command: "node",
          args: [bridgeScript, "--workspace", normalizedWorkspace],
        },
      },
    };

    const res = await this.request("thread/start", {
      cwd: workspace,
      model: opts.model || "chatgpt-6-astra",
      config: configOverrides,
    });

    this.threadId = res?.thread?.id || res?.threadId;
    return this.threadId;
  }

  /**
   * Start a new turn with the user prompt.
   */
  async startTurn(prompt, opts = {}) {
    if (!this.threadId) {
      throw new Error("No active thread. Call startThread() first.");
    }

    const input = [
      {
        type: "text",
        text: prompt,
        text_elements: [],
      },
    ];

    const params = {
      threadId: this.threadId,
      input,
    };

    if (opts.model) params.model = opts.model;
    if (opts.effort) params.effort = opts.effort;

    const res = await this.request("turn/start", params);
    this.activeTurnId = res?.turn?.id || res?.turnId;
    return this.activeTurnId;
  }

  /**
   * Interrupt the active turn.
   */
  async interruptTurn() {
    if (!this.threadId || !this.activeTurnId) return;
    try {
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Handle incoming stdout data buffer from Codex.
   */
  _handleStdout(chunk) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop(); // keep partial trailing line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Check if it is a response to a pending request
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const { resolve, reject, timeout } = this.pendingRequests.get(msg.id);
        clearTimeout(timeout);
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          resolve(msg.result);
        }
        continue;
      }

      // Otherwise it's a notification or server request
      this._handleNotification(msg);
    }
  }

  /**
   * Route server notifications to typed events.
   */
  _handleNotification(msg) {
    const method = msg.method;
    const params = msg.params || {};

    this.emit("notification", msg);

    switch (method) {
      case "item/agentMessage/delta":
        // Assistant text delta
        this.emit("delta", params.delta || "");
        break;

      case "item/reasoning/delta":
        // Reasoning text delta
        this.emit("reasoning", params.delta || "");
        break;

      case "item/started":
        // Tool call or item started
        this.emit("item_started", params);
        break;

      case "item/completed":
        // Tool call or item completed
        this.emit("item_completed", params);
        break;

      case "turn/completed":
        this.activeTurnId = null;
        this.emit("turn_completed", params);
        break;

      case "account/rateLimits/updated":
        this.emit("rate_limits", params);
        break;

      case "error":
        this.emit("server_error", params);
        break;
    }
  }

  /**
   * Terminate the client and background process cleanly.
   */
  async stop() {
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error("Codex client stopped"));
    }
    this.pendingRequests.clear();
  }
}
