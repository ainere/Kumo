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
      chatTaken: (chatId, self) => this.chatTaken(chatId, self),
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

  /**
   * Whether a session other than `self` has this chat open. Two leads on one
   * chat would talk over each other in its log and its thread.
   *
   * @param {string} chatId
   * @param {Session} [self]
   */
  chatTaken(chatId, self) {
    return this.list().some((s) => s !== self && s.chatId === chatId);
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
