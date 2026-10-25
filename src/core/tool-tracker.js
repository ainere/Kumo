/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

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
 *   role: string|null,
 *   task: string,
 *   model: string|null,
 *   effort: string|null,
 *   startedAt: number,
 *   runId: string|null,
 * }} ToolCall
 * @typedef {{ runId: string, tool: string, task: string }} BridgeRun
 */

/**
 * One worker call as a turn's record keeps it (the shape the desktop app's
 * `TurnTool` reads). `ok` and `elapsedMs` stay null for a call whose end the
 * orchestrator never reported.
 *
 * @typedef {{
 *   toolId: string,
 *   name: string,
 *   role: string|null,
 *   task: string,
 *   model: string|null,
 *   effort: string|null,
 *   ok: boolean|null,
 *   elapsedMs: number|null,
 *   output: string,
 * }} TurnTool
 */

/** Output kept for a run that has not been matched to a call yet. */
const MAX_PENDING_OUTPUT = 256 * 1024;

/** What one turn's record keeps of its trace, so a runaway turn cannot bloat the chat log. */
export const TRACE_LIMITS = Object.freeze({
  /** The end of the lead's reasoning. */
  reasoningChars: 20_000,
  /** The end of each worker call's output. */
  toolOutputChars: 8_000,
  /** The start of each worker call's task, which the orchestrator writes and can make any length. */
  taskChars: 4_000,
  /** The first worker calls of the turn. */
  tools: 50,
  /** Files changed by approved diffs. */
  diffPaths: 100,
});

/**
 * The last `n` characters of `text`, without the second half of a surrogate
 * pair at the cut.
 *
 * @param {string} text
 * @param {number} n
 */
function tail(text, n) {
  if (text.length <= n) return text;
  let cut = text.length - n;
  const unit = text.charCodeAt(cut);
  if (unit >= 0xdc00 && unit <= 0xdfff) cut++;
  return text.slice(cut);
}

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
   * @param {{ role?: string|null, model?: string|null, effort?: string|null }} [defaults]
   *   the role the tool belongs to and the worker configured for it
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
      role: defaults.role ?? null,
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

/**
 * What a turn did besides answering: the lead's reasoning, its worker calls
 * with their output, and the files its approved diffs changed. The session
 * feeds it from the same places it emits events, and writes `snapshot()` into
 * the turn's record when the turn succeeds. Everything is bounded by
 * TRACE_LIMITS, keeping the end of a stream: that is where the result is.
 */
export class TurnTrace {
  constructor() {
    this.reasoning = "";
    /** @type {Map<string, TurnTool>} */
    this.tools = new Map();
    /** @type {Set<string>} */
    this.diffPaths = new Set();
  }

  /** @param {string} text a piece of the lead's reasoning */
  addReasoning(text) {
    if (!text) return;
    this.reasoning += text;
    // Cut in bulk, so a long stream is not copied on every piece.
    if (this.reasoning.length > 2 * TRACE_LIMITS.reasoningChars) {
      this.reasoning = tail(this.reasoning, TRACE_LIMITS.reasoningChars);
    }
  }

  /** @param {ToolCall} call */
  toolStarted(call) {
    if (this.tools.size >= TRACE_LIMITS.tools || this.tools.has(call.id)) return;
    this.tools.set(call.id, {
      toolId: call.id,
      name: call.name,
      role: call.role,
      task: call.task.slice(0, TRACE_LIMITS.taskChars),
      model: call.model,
      effort: call.effort,
      ok: null,
      elapsedMs: null,
      output: "",
    });
  }

  /**
   * @param {string} toolId
   * @param {string} text
   */
  toolOutput(toolId, text) {
    const tool = this.tools.get(toolId);
    if (!tool || !text) return;
    tool.output += text;
    if (tool.output.length > 2 * TRACE_LIMITS.toolOutputChars) tool.output = tail(tool.output, TRACE_LIMITS.toolOutputChars);
  }

  /**
   * @param {string} toolId
   * @param {{ ok: boolean, elapsedMs: number }} result
   */
  toolCompleted(toolId, { ok, elapsedMs }) {
    const tool = this.tools.get(toolId);
    if (!tool) return;
    tool.ok = ok;
    tool.elapsedMs = elapsedMs;
  }

  /** @param {string[]} paths workspace-relative paths of an approved diff */
  addDiffPaths(paths) {
    for (const p of paths) {
      if (this.diffPaths.size >= TRACE_LIMITS.diffPaths) return;
      this.diffPaths.add(p);
    }
  }

  /**
   * The fields a turn record gains from the trace; one the turn did not
   * produce is left out, so a plain turn's record is the same as before.
   *
   * @returns {{ reasoning?: string, tools?: TurnTool[], diffPaths?: string[] }}
   */
  snapshot() {
    /** @type {{ reasoning?: string, tools?: TurnTool[], diffPaths?: string[] }} */
    const out = {};
    const reasoning = tail(this.reasoning, TRACE_LIMITS.reasoningChars).trim();
    if (reasoning) out.reasoning = reasoning;
    if (this.tools.size > 0) {
      out.tools = [...this.tools.values()].map((t) => ({ ...t, output: tail(t.output, TRACE_LIMITS.toolOutputChars) }));
    }
    if (this.diffPaths.size > 0) out.diffPaths = [...this.diffPaths];
    return out;
  }
}
