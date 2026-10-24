// @ts-check
/**
 * session-manager.js — Several sessions side by side, one event stream.
 *
 * The desktop app runs a session per open chat window; the CLI runs one. New
 * sessions start from the saved config (the defaults) and diverge only
 * through their own updateSettings, so one window's model or safety switch
 * never reaches another's turn. Every session's events are re-emitted here,
 * already tagged with their `sessionId`.
 */

import { EventEmitter } from "node:events";
import { loadConfig } from "../config/settings.js";
import { Session } from "./session.js";
import { snapshotSettings } from "./settings.js";

/** @typedef {import("./session.js").SessionOptions} SessionOptions */

export class SessionManager extends EventEmitter {
  /**
   * @param {{ defaults?: () => Record<string, any>, sessionOptions?: Partial<SessionOptions> }} [opts]
   *   defaults: where new sessions take their settings from (the saved config)
   */
  constructor(opts = {}) {
    super();
    this.defaults = opts.defaults || (() => loadConfig());
    this.sessionOptions = opts.sessionOptions || {};
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /**
   * Create and start a session.
   *
   * @param {Omit<SessionOptions, "settings"> & { settings?: Partial<Record<string, unknown>> }} opts
   * @returns {Promise<Session>}
   */
  async create(opts) {
    const { settings: overrides, ...rest } = opts;
    const session = new Session({
      ...this.sessionOptions,
      ...rest,
      settings: snapshotSettings(this.defaults()),
    });
    if (overrides) await session.updateSettings(overrides);
    this.sessions.set(session.id, session);
    session.on("event", (event) => {
      this.emit("event", event);
      if (event.type === "session.closed") this.sessions.delete(session.id);
    });
    // A failed start is reported by the session and retried on its first
    // prompt; it does not make the session unusable.
    await session.start().catch(() => {});
    return session;
  }

  /** @param {string} id */
  get(id) {
    return this.sessions.get(id) || null;
  }

  list() {
    return [...this.sessions.values()];
  }

  /** @param {string} id */
  async close(id) {
    await this.sessions.get(id)?.stop();
  }

  async closeAll() {
    await Promise.all(this.list().map((s) => s.stop()));
  }
}
