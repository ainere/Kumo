// @ts-check
/**
 * live-log-tailer.js — Worker output for bridges with no engine connection.
 *
 * A bridge that cannot reach its session (an orchestrator that does not pass
 * the engine's address on) writes each run's output to
 * `<session dir>/live/live-<runId>.log` and registers the run. This follows
 * one call's log: the file named after the call's own id when the bridge
 * knows it, else the newest registered run. The engine connection replaces
 * this whenever it is available, because only it knows which run is whose.
 */

import fs from "node:fs";
import { getLiveLogPath, getActiveLiveRun, readLiveLogChunk } from "../data/sessions.js";

export class LiveLogTailer {
  /**
   * @param {{ workspace: string, toolId: string, onText: (text: string) => void, intervalMs?: number }} opts
   */
  constructor({ workspace, toolId, onText, intervalMs = 80 }) {
    this.workspace = workspace;
    this.toolId = toolId;
    this.onText = onText;
    this.intervalMs = intervalMs;
    /** @type {string|null} */
    this.runId = null;
    this.offset = 0;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._poll(), this.intervalMs);
    this.timer.unref();
  }

  _find() {
    if (this.runId) return;
    if (fs.existsSync(getLiveLogPath(this.workspace, this.toolId))) {
      this.runId = this.toolId;
      return;
    }
    const active = getActiveLiveRun(this.workspace);
    if (active?.runId && fs.existsSync(getLiveLogPath(this.workspace, active.runId))) this.runId = active.runId;
  }

  _pump() {
    if (!this.runId) return;
    const chunk = readLiveLogChunk(this.workspace, this.runId, this.offset);
    this.offset = chunk.offset;
    if (chunk.text) this.onText(chunk.text);
  }

  _poll() {
    try {
      this._find();
      this._pump();
    } catch {
      /* transient read errors */
    }
  }

  /** Stop, drain what is left, and delete the log unless another call's run still writes it. */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this._pump();
      if (this.runId && !getActiveLiveRun(this.workspace, this.runId)) {
        fs.unlinkSync(getLiveLogPath(this.workspace, this.runId));
      }
    } catch {
      /* best effort */
    }
  }
}
