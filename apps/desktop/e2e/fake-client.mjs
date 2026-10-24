/**
 * A scripted orchestrator for the desktop end-to-end tests. The engine host
 * loads it in place of a real provider client when both KUMO_E2E=1 and
 * KUMO_E2E_CLIENT (this file's path) are set.
 *
 * Every turn streams a short Markdown answer. A prompt containing
 * "delegate" also runs a worker call with live output; one containing
 * "approve" asks the operator to approve a command and, when approved,
 * writes approved.txt into the workspace.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClient({ workspace }) {
  const client = new EventEmitter();
  let turns = 0;
  let interrupted = false;

  client.start = async () => {};
  client.startThread = async () => {};
  client.currentThreadId = () => "e2e-thread";
  client.stop = async () => {};
  client.getRateLimits = async () => ({
    usedPercent: 25,
    remainingPercent: 75,
    resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600,
    resetFormatted: "in 3h",
    windowMinutes: 300,
  });
  client.interruptTurn = async () => {
    interrupted = true;
  };

  async function script(prompt) {
    turns += 1;
    interrupted = false;
    client.emit("delta", "Looking at **the workspace**.\n\n");
    await wait(40);

    if (/delegate/i.test(prompt)) {
      const item = {
        id: `e2e-tool-${turns}`,
        type: "mcpToolCall",
        name: "worker_explore",
        arguments: { task: "List the files in the workspace", model: "e2e-worker" },
      };
      client.emit("item_started", { item });
      await wait(300);
      client.emit("item_completed", { item: { ...item, status: "completed" } });
      client.emit("delta", "The scout finished.\n\n");
    }

    if (/approve/i.test(prompt)) {
      const decision = await new Promise((resolve) => {
        client.emit("server_request", {
          isApproval: true,
          method: "execCommand",
          description: "echo approved > approved.txt",
          approve: () => resolve(true),
          decline: () => resolve(false),
        });
      });
      if (decision) fs.writeFileSync(path.join(workspace, "approved.txt"), "approved\n");
      client.emit("delta", decision ? "Approved and written.\n\n" : "Declined.\n\n");
    }

    if (interrupted) {
      client.emit("turn_completed", { ok: false, reason: "interrupted" });
      return;
    }
    client.emit("delta", "```js\nconsole.log(\"done\");\n```\n");
    client.emit("turn_completed", { ok: true });
  }

  client.startTurn = async (prompt) => {
    setTimeout(() => void script(String(prompt)), 20);
    return {};
  };

  return client;
}
