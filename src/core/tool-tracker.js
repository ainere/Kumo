// @ts-check
/**
 * tool-tracker.js — Which worker calls are running in a turn, and which
 * bridge run produces each one's output.
 *
 * The orchestrator reports a call (`item_started` with its tool name and
 * arguments); the bridge separately reports the run it starts for it
 * (`run.started` with the same tool name and task). Matching on both is what
 * keeps two parallel calls' output apart — before, every tailer adopted "the
 * newest active run", so concurrent calls streamed the same log.
 */

import { randomUUID } from "node:crypto";
import { isToolCallItem, toolNameOf, toolArgsOf } from "../providers/orchestrators/items.js";
import { isValidId } from "../data/sessions.js";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   task: string,
 *   model: string|null,
 *   effort: string|null,
 *   startedAt: number,
 *   runId: string|null,
 * }} ToolCall
 * @typedef {{ runId: string, tool: string, task: string }} BridgeRun
 */

/** Output kept for a run that has not been matched to a call yet. */
const MAX_PENDING_OUTPUT = 256 * 1024;

export class ToolTracker {
  constructor() {
    /** @type {Map<string, ToolCall>} */
    this.active = new Map();
    /** @type {BridgeRun[]} runs reported before their call */
    this.pendingRuns = [];
    /** @type {Map<string, string>} output of runs not matched yet */
    this.pendingOutput = new Map();
  }

  /**
   * Register a call from an `item_started` item. Non-tool items return null.
   *
   * @param {any} item
   * @param {{ model?: string|null, effort?: string|null }} [defaults] - the configured worker
   * @returns {ToolCall|null}
   */
  start(item, defaults = {}) {
    if (!isToolCallItem(item)) return null;
    const args = toolArgsOf(item);
    /** @type {ToolCall} */
    const call = {
      // The id names a log file in the fallback path, so it must be safe there.
      id: isValidId(item?.id) ? item.id : randomUUID(),
      name: toolNameOf(item),
      task: typeof args.task === "string" ? args.task : "",
      model: args.model || item?.model || defaults.model || null,
      effort: args.effort || item?.effort || defaults.effort || null,
      startedAt: Date.now(),
      runId: null,
    };
    this.active.set(call.id, call);
    const index = this.pendingRuns.findIndex((r) => r.tool === call.name && r.task === call.task);
    if (index !== -1) call.runId = this.pendingRuns.splice(index, 1)[0].runId;
    return call;
  }

  /**
   * Finish the call an `item_completed` item refers to and return it, or null
   * when no active call matches with confidence (the turn's end clears it).
   *
   * @param {any} item
   * @returns {ToolCall|null}
   */
  complete(item) {
    let id = item?.id;
    if ((!id || !this.active.has(id)) && this.active.size > 0) {
      id = null;
      const name = item?.name || item?.tool || toolNameOf(item);
      const args = toolArgsOf(item);
      const sig = (typeof item?.task === "string" ? item.task : "") || (typeof args.task === "string" ? args.task : "");
      if (sig || name) {
        for (const [candidate, call] of this.active) {
          const nameMatch = !name || call.name === name;
          const taskMatch = sig && call.task && (call.task === sig || call.task.includes(sig) || sig.includes(call.task));
          if (nameMatch && taskMatch) {
            id = candidate;
            break;
          }
        }
        if (!id) {
          const byName = [...this.active.values()].filter((c) => !name || c.name === name);
          if (byName.length === 1) id = byName[0].id;
        }
      }
    }
    if (!id || !this.active.has(id)) return null;
    const call = /** @type {ToolCall} */ (this.active.get(id));
    this.active.delete(id);
    return call;
  }

  /**
   * A bridge run started. Returns the call it belongs to, or null when that
   * call has not been reported yet (the run is kept and matched later).
   *
   * @param {BridgeRun} run
   * @returns {ToolCall|null}
   */
  attachRun(run) {
    const free = [...this.active.values()].filter((c) => !c.runId);
    const call =
      free.find((c) => c.name === run.tool && c.task === run.task) ||
      // An orchestrator may report the task slightly differently; a single
      // unmatched call of that tool is still unambiguous.
      (free.filter((c) => c.name === run.tool).length === 1 ? free.find((c) => c.name === run.tool) : undefined);
    if (call) {
      call.runId = run.runId;
      return call;
    }
    this.pendingRuns.push(run);
    return null;
  }

  /**
   * The call a run's output belongs to; output of an unmatched run is held.
   *
   * @param {string} runId
   * @param {string} text
   * @returns {{ call: ToolCall, text: string } | null}
   */
  outputFor(runId, text) {
    const call = this.byRun(runId);
    if (!call) {
      const held = (this.pendingOutput.get(runId) || "") + text;
      this.pendingOutput.set(runId, held.slice(-MAX_PENDING_OUTPUT));
      return null;
    }
    const held = this.pendingOutput.get(runId);
    if (held) this.pendingOutput.delete(runId);
    return { call, text: (held || "") + text };
  }

  /**
   * Output held for a run, released once its call is known.
   *
   * @param {string} runId
   * @returns {string}
   */
  takeHeldOutput(runId) {
    const held = this.pendingOutput.get(runId) || "";
    this.pendingOutput.delete(runId);
    return held;
  }

  /** @param {string} runId */
  byRun(runId) {
    for (const call of this.active.values()) if (call.runId === runId) return call;
    return null;
  }

  /** End of turn: forget everything and return the calls still open. */
  clear() {
    const open = [...this.active.values()];
    this.active.clear();
    this.pendingRuns = [];
    this.pendingOutput.clear();
    return open;
  }
}
