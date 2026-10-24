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
 * protocol.js — Framing shared by the engine and the bridge.
 *
 * Messages are JSON-RPC 2.0 objects, one per line (NDJSON), over a Windows
 * named pipe or a unix socket. The first message on every connection must be
 * `hello` with the session token; anything else closes the connection.
 *
 * Bridge → engine:
 *   hello            {token, pid, version}       → {sessionId, interactive}
 *   settings.get     {}                          → session settings
 *   approval.request {previewId, tool, previewText} → {approved, reason?}
 *   run.started      {runId, tool, task}         (notification)
 *   run.output       {runId, text}               (notification)
 *   run.finished     {runId, ok}                 (notification)
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomBytes } from "node:crypto";

/** A line longer than this ends the connection rather than grow without bound. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Environment variables that tell a bridge where its engine is. */
export const ENGINE_ENDPOINT_ENV = "KUMO_ENGINE_ENDPOINT";
export const SESSION_TOKEN_ENV = "KUMO_SESSION_TOKEN";

/**
 * A fresh endpoint path. On Windows a named pipe; elsewhere a socket inside
 * a new 0700 directory, so no other user can reach it.
 *
 * @returns {{ endpoint: string, cleanup: () => void }}
 */
export function newEndpoint() {
  const id = `${process.pid}-${randomBytes(8).toString("hex")}`;
  if (process.platform === "win32") {
    return { endpoint: `\\\\.\\pipe\\kumo-${id}`, cleanup: () => {} };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-ipc-"));
  fs.chmodSync(dir, 0o700);
  return {
    endpoint: path.join(dir, "engine.sock"),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Split a byte stream into JSON messages, one per line.
 *
 * @param {import("node:net").Socket} socket
 * @param {(message: any) => void} onMessage
 * @param {(error: Error) => void} onError - malformed or oversized input
 */
export function readMessages(socket, onMessage, onError) {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
      onError(new Error("message exceeds the size limit"));
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        onError(new Error("malformed message"));
        return;
      }
      onMessage(message);
    }
  });
}

/**
 * @param {import("node:net").Socket} socket
 * @param {object} message
 */
export function writeMessage(socket, message) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
