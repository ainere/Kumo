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
 * node-command.js — How to start a Node script (the kumo-bridge) from here.
 *
 * Orchestrators launch the bridge as `<command> src/bridge/server.js`. Under
 * the CLI, `process.execPath` is node. Inside the desktop app it is the
 * Electron binary, which only behaves as node with ELECTRON_RUN_AS_NODE=1 —
 * without it the orchestrator would open a second copy of the app instead of
 * running the bridge.
 *
 * Configs written into a workspace (`kumo init`'s `.codex/config.toml`,
 * Antigravity's `.agents/mcp_config.json`) outlive the app session and are
 * also read by the CLI, so for those a real node from PATH is preferred.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveBinary } from "../utils/process.js";

export const RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";

/** Whether this process is Electron (main or utility process). */
export function runningInElectron() {
  return Boolean(process.versions.electron);
}

/**
 * @param {{ persistent?: boolean, electron?: boolean, execPath?: string, findNode?: () => string | null }} [opts]
 *   persistent: the command is written into a file that outlives this process;
 *   electron / execPath / findNode: test seams
 * @returns {{ command: string, env: Record<string, string> }}
 */
export function nodeCommand({
  persistent = false,
  electron = runningInElectron(),
  execPath = process.execPath,
  findNode = systemNode,
} = {}) {
  if (!electron) return { command: execPath, env: {} };
  if (persistent) {
    const node = findNode();
    if (node) return { command: node, env: {} };
  }
  return { command: execPath, env: { [RUN_AS_NODE_ENV]: "1" } };
}

/** A node executable on PATH, or null. */
function systemNode() {
  const node = resolveBinary(process.platform === "win32" ? "node.exe" : "node");
  return node && path.isAbsolute(node) && fs.existsSync(node) ? node : null;
}
