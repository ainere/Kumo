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
 * engine-server.js — The engine end of the engine ↔ bridge connection.
 *
 * Each Session listens on its own endpoint and hands its address and a
 * random token to the orchestrator, which passes both on to the kumo-bridge
 * it starts. The bridge then asks the session for its settings, streams
 * worker output tagged with the run it belongs to, and asks for approvals —
 * all over this connection instead of the files the CLI used to poll.
 */

import net from "node:net";
import { EventEmitter } from "node:events";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { newEndpoint, readMessages, writeMessage } from "./protocol.js";

/**
 * @typedef {(params: any, connection: EngineConnectionInfo) => unknown | Promise<unknown>} Handler
 * @typedef {{ id: number, pid: number | null }} EngineConnectionInfo
 */

export class EngineIpcServer extends EventEmitter {
  /**
   * @param {{
   *   requests: Record<string, Handler>,
   *   notifications?: Record<string, Handler>,
   *   hello?: (params: any) => object,
   * }} handlers
   */
  constructor(handlers) {
    super();
    this.handlers = handlers;
    this.token = randomBytes(32).toString("hex");
    /** @type {string|null} */
    this.endpoint = null;
    /** @type {Set<import("node:net").Socket>} */
    this.sockets = new Set();
    this.authenticated = 0;
    this._nextId = 1;
    this._cleanup = () => {};
    /** @type {import("node:net").Server|null} */
    this.server = null;
  }

  /** Number of bridges currently connected and authenticated. */
  get connectedBridges() {
    return this.authenticated;
  }

  /** @returns {Promise<string>} the endpoint address */
  async listen() {
    const { endpoint, cleanup } = newEndpoint();
    this._cleanup = cleanup;
    this.server = net.createServer((socket) => this._accept(socket));
    await new Promise((resolve, reject) => {
      const server = /** @type {import("node:net").Server} */ (this.server);
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve(undefined);
      });
    });
    this.endpoint = endpoint;
    return endpoint;
  }

  /** @param {string} candidate */
  _tokenMatches(candidate) {
    const a = Buffer.from(String(candidate || ""));
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** @param {import("node:net").Socket} socket */
  _accept(socket) {
    this.sockets.add(socket);
    /** @type {EngineConnectionInfo} */
    const info = { id: this._nextId++, pid: null };
    let authed = false;
    const close = () => socket.destroy();

    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (authed) {
        this.authenticated--;
        this.emit("disconnect", info);
      }
    });

    readMessages(
      socket,
      async (message) => {
        if (!authed) {
          if (message?.method !== "hello" || !this._tokenMatches(message?.params?.token)) {
            close();
            return;
          }
          authed = true;
          this.authenticated++;
          info.pid = typeof message.params.pid === "number" ? message.params.pid : null;
          const result = this.handlers.hello ? this.handlers.hello(message.params) : {};
          writeMessage(socket, { id: message.id, result });
          this.emit("connection", info);
          return;
        }

        const method = String(message?.method || "");
        if (message.id === undefined || message.id === null) {
          const handler = this.handlers.notifications?.[method];
          if (handler) {
            try {
              await handler(message.params || {}, info);
            } catch {
              /* a notification has nobody to report to */
            }
          }
          return;
        }

        const handler = this.handlers.requests[method];
        if (!handler) {
          writeMessage(socket, { id: message.id, error: { code: -32601, message: `unknown method ${method}` } });
          return;
        }
        try {
          const result = await handler(message.params || {}, info);
          writeMessage(socket, { id: message.id, result: result ?? null });
        } catch (err) {
          writeMessage(socket, {
            id: message.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
      },
      close
    );
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(() => resolve(undefined)));
    this._cleanup();
  }
}
