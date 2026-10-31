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

/**
 * lead-support.js — What the CLI leads that reach Kumo's worker bridge share
 * (GitHub Copilot CLI, OpenCode): how the bridge is launched, and reading the
 * line-delimited JSON their `--json` style output formats print.
 */

import { BRIDGE_SERVER_PATH } from "../../config/sync.js";
import { nodeCommand } from "../../core/node-command.js";

/** The name the bridge goes by in a lead's MCP config; its tool names derive from it. */
export const BRIDGE_SERVER_NAME = "kumo-bridge";

/**
 * How a lead starts the bridge for `workspace`: the command, its arguments and
 * the environment it gets. `env` is what the caller adds (the session's engine
 * endpoint and token, the bridge's own variables); it can carry the session
 * token, so where it is written matters to the caller.
 *
 * @param {{ workspace: string, env?: Record<string, string> }} opts
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function bridgeLaunch({ workspace, env = {} }) {
  const node = nodeCommand();
  return {
    command: node.command,
    args: [BRIDGE_SERVER_PATH, "--workspace", workspace],
    env: {
      ...node.env,
      ...env,
      KUMO_WORKSPACE: workspace,
      ...(process.env.KUMO_HOME ? { KUMO_HOME: process.env.KUMO_HOME } : {}),
    },
  };
}

/**
 * Hands out the complete lines of streamed text. A chunk may end mid-line, so
 * the rest waits for the next one; `flush` hands out what is left when the
 * stream ends without a final newline.
 */
export class LineReader {
  /** @param {(line: string) => void} onLine called with each non-empty, trimmed line */
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = "";
  }

  /** @param {string} text */
  push(text) {
    this.buffer += text;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  flush() {
    const line = this.buffer.trim();
    this.buffer = "";
    if (line) this.onLine(line);
  }
}

/**
 * A line as a JSON object, or null when it is anything else — plain text, a
 * diagnostic, or JSON that is not an object.
 *
 * @param {string} line
 * @returns {Record<string, any> | null}
 */
export function parseJsonObject(line) {
  if (line[0] !== "{") return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
