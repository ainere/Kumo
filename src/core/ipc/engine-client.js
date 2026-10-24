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
 * engine-client.js — The bridge end of the engine ↔ bridge connection.
 *
 * The bridge connects when it starts, if its environment names an engine.
 * Any failure — no engine, a wrong token, a closed pipe — leaves it on the
 * file-based fallback, so a bridge started by a plain `codex` (no Kumo
 * engine around it) still works as before.
 */

import net from "node:net";
import { EventEmitter } from "node:events";
import { readMessages, writeMessage, ENGINE_ENDPOINT_ENV, SESSION_TOKEN_ENV } from "./protocol.js";

export class EngineConnection extends EventEmitter {
  /**
   * @param {import("node:net").Socket} socket
   */
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    /** @type {{ sessionId?: string, interactive?: boolean }} */
    this.hello = {};
    this._nextId = 1;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout | null }>} */
    this._pending = new Map();

    socket.on("error", () => {});
    socket.on("close", () => {
      this.closed = true;
      for (const { reject, timer } of this._pending.values()) {
        if (timer) clearTimeout(timer);
        reject(new Error("engine connection closed"));
      }
      this._pending.clear();
      this.emit("close");
    });
    readMessages(
      socket,
      (message) => {
        const pending = this._pending.get(message?.id);
        if (!pending) return;
        this._pending.delete(message.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || "engine error"));
        else pending.resolve(message.result);
      },
      () => socket.destroy()
    );
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [opts] - 0 waits indefinitely
   * @returns {Promise<any>}
   */
  request(method, params = {}, { timeoutMs = 10000 } = {}) {
    if (this.closed) return Promise.reject(new Error("engine connection closed"));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this._pending.delete(id);
              reject(new Error(`engine did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
            }, timeoutMs)
          : null;
      this._pending.set(id, { resolve, reject, timer });
      writeMessage(this.socket, { id, method, params });
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   */
  notify(method, params = {}) {
    if (!this.closed) writeMessage(this.socket, { method, params });
  }

  close() {
    this.socket.destroy();
  }
}

/**
 * Connect and authenticate, or return null.
 *
 * @param {{ endpoint?: string, token?: string, timeoutMs?: number, version?: string }} [opts]
 *   defaults to KUMO_ENGINE_ENDPOINT / KUMO_SESSION_TOKEN
 * @returns {Promise<EngineConnection|null>}
 */
export async function connectEngine(opts = {}) {
  const endpoint = opts.endpoint ?? process.env[ENGINE_ENDPOINT_ENV];
  const token = opts.token ?? process.env[SESSION_TOKEN_ENV];
  if (!endpoint || !token) return null;
  const timeoutMs = opts.timeoutMs ?? 3000;

  const socket = await new Promise((resolve) => {
    const s = net.connect(endpoint);
    const timer = setTimeout(() => {
      s.destroy();
      resolve(null);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (!socket) return null;

  const connection = new EngineConnection(/** @type {import("node:net").Socket} */ (socket));
  try {
    connection.hello = await connection.request(
      "hello",
      { token, pid: process.pid, version: opts.version || null },
      { timeoutMs }
    );
    return connection;
  } catch {
    connection.close();
    return null;
  }
}
