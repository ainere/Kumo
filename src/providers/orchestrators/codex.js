/**
 * codex.js — OpenAI Codex orchestrator provider metadata and binary discovery.
 *
 * Session management lives in `codex-client.js` (JSON-RPC over `codex app-server`);
 * this module only answers "which Codex executable should we use, and what does
 * this provider support".
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveBinary } from "../../utils/process.js";

export const PROVIDER_INFO = {
  id: "codex",
  name: "OpenAI Codex CLI",
  defaultModel: "chatgpt-6-astra",
  supportedReasoning: ["low", "medium", "high", "max"],
};

/**
 * Locate the Codex executable on the system.
 *
 * @returns {string} an absolute path when one is found, otherwise the bare name
 */
export function findCodexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;

  // Windows: check local AppData, npm global, and PATH
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const appData = process.env.APPDATA || "";
    const candidates = [
      path.join(localAppData, "Programs", "OpenAI", "Codex", "codex.exe"),
      path.join(appData, "npm", "codex.cmd"),
      path.join(localAppData, "npm", "codex.cmd"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Codex", "codex.exe"),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  }

  // Unix-like fallback
  const unixCandidates = [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    path.join(os.homedir(), ".npm-global", "bin", "codex"),
  ];

  for (const c of unixCandidates) {
    if (fs.existsSync(c)) return c;
  }

  // Last resort: ask the shell. Returns the bare name when nothing is on PATH.
  return resolveBinary("codex");
}
