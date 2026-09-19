/**
 * sessions.js — Multi-chat session persistence and project registry for Kumo.
 *
 * Data layout (root is `KUMO_HOME`, default `~/.kumo`):
 *   <kumoHome>/projects.json       — Global registry: { [pathHash]: { path, name, lastOpened } }
 *   <kumoHome>/sessions/<pathHash>/
 *     ├── chats.json            — Chat index: [{ id, title, createdAt, lastUsedAt, threadId, model, turns }]
 *     ├── <chatId>.json         — Turn log (JSON lines): { prompt, responseSummary, timestamp, model, elapsedMs }
 *     └── live/
 *         ├── live-<runId>.log  — Raw worker stdout/stderr
 *         └── active/<runId>.json — One file per in-flight worker run
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { kumoHome, ensureDir, atomicWriteJson, quarantineCorruptFile } from "../config/paths.js";

/** A worker registration older than this is treated as an orphan from a killed process. */
export const ACTIVE_RUN_MAX_AGE_MS = 60 * 1000;

function dataDir() {
  return kumoHome();
}

function projectsFile() {
  return path.join(dataDir(), "projects.json");
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a chat id (prevents path traversal via `../../evil` ids).
 *
 * @param {string} chatId
 */
function assertChatId(chatId) {
  if (!ID_RE.test(chatId || "")) {
    throw new Error("Invalid chatId");
  }
}

/**
 * Validate a worker run id — it reaches the filesystem as `live-<runId>.log`
 * and originates from provider-supplied event ids.
 *
 * @param {string} runId
 */
export function assertRunId(runId) {
  if (!ID_RE.test(runId || "")) {
    throw new Error("Invalid runId");
  }
}

/** True when `id` is safe to use as a path component. */
export function isValidId(id) {
  return ID_RE.test(id || "");
}

// ── Project Registry ──

/**
 * Hash a workspace path into a stable session directory name.
 * Case is folded only on case-insensitive filesystems; folding on Linux would
 * collide `/srv/Project` with `/srv/project`.
 */
export function hashWorkspace(workspacePath) {
  const resolved = path.resolve(workspacePath);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  return crypto
    .createHash("sha256")
    .update(caseInsensitive ? resolved.toLowerCase() : resolved)
    .digest("hex")
    .slice(0, 12);
}

export function loadProjectRegistry() {
  try {
    const file = projectsFile();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {
    /* ignore corrupt file */
  }
  return {};
}

export function registerProject(workspacePath) {
  const resolved = path.resolve(workspacePath);
  const hash = hashWorkspace(resolved);
  const registry = loadProjectRegistry();

  registry[hash] = {
    path: resolved,
    name: path.basename(resolved) || resolved,
    lastOpened: Date.now(),
  };

  try {
    atomicWriteJson(projectsFile(), registry);
  } catch {
    /* ignore write errors */
  }

  return registry[hash];
}

export function listProjects() {
  const registry = loadProjectRegistry();
  return Object.values(registry).sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
}

// ── Chat Index ──

export function getSessionDir(workspacePath) {
  return path.join(dataDir(), "sessions", hashWorkspace(workspacePath));
}

export function loadChatIndex(workspacePath) {
  const dir = getSessionDir(workspacePath);
  const file = path.join(dir, "chats.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Never let the next write silently overwrite an unreadable index.
    const moved = quarantineCorruptFile(file);
    if (moved) {
      console.warn(`[Warning] Corrupt chat index quarantined at ${moved}`);
    }
    return [];
  }
}

function saveChatIndex(workspacePath, chats) {
  const dir = getSessionDir(workspacePath);
  atomicWriteJson(path.join(dir, "chats.json"), chats);
}

export function createChat(workspacePath, opts = {}) {
  const dir = getSessionDir(workspacePath);
  ensureDir(dir);

  const chats = loadChatIndex(workspacePath);
  const chatId = `chat-${crypto.randomUUID()}`;
  const entry = {
    id: chatId,
    title: opts.title || "New Chat",
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    threadId: opts.threadId || null,
    model: opts.model || null,
    effort: opts.effort || null,
    turns: 0,
  };

  chats.unshift(entry);
  saveChatIndex(workspacePath, chats);
  return chatId;
}

export function updateChat(workspacePath, chatId, updates) {
  if (!chatId) return false;
  assertChatId(chatId);
  const chats = loadChatIndex(workspacePath);
  const idx = chats.findIndex((c) => c.id === chatId);
  if (idx === -1) return false;

  chats[idx] = { ...chats[idx], ...updates };
  saveChatIndex(workspacePath, chats);
  return true;
}

export function deleteChat(workspacePath, chatId) {
  if (!chatId) return;
  assertChatId(chatId);
  const chats = loadChatIndex(workspacePath);
  const filtered = chats.filter((c) => c.id !== chatId);
  saveChatIndex(workspacePath, filtered);

  const turnFile = path.join(getSessionDir(workspacePath), `${chatId}.json`);
  try {
    if (fs.existsSync(turnFile)) {
      fs.unlinkSync(turnFile);
    }
  } catch {
    /* ignore */
  }
}

export function listChats(workspacePath) {
  const chats = loadChatIndex(workspacePath);
  return chats.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
}

// ── Turn Log ──

export function appendTurn(workspacePath, chatId, turn) {
  if (!chatId) return;
  assertChatId(chatId);
  const dir = getSessionDir(workspacePath);
  ensureDir(dir);
  const file = path.join(dir, `${chatId}.json`);
  try {
    fs.appendFileSync(file, JSON.stringify(turn) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* ignore */
  }
}

export function loadTurnLog(workspacePath, chatId) {
  if (!chatId) return [];
  assertChatId(chatId);
  const dir = getSessionDir(workspacePath);
  const file = path.join(dir, `${chatId}.json`);
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf-8");
      const turns = [];
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          turns.push(JSON.parse(line));
        } catch {
          continue;
        }
      }
      return turns;
    }
  } catch {
    /* ignore */
  }
  return [];
}

// ── Auto-Title ──

export function generateChatTitle(firstPrompt) {
  if (!firstPrompt) return "New Chat";
  const clean = firstPrompt.replace(/\s+/g, " ").trim();
  return clean.length > 50 ? clean.slice(0, 47) + "..." : clean;
}

// ── Live Worker Streaming Logs ──

export function getLiveLogDir(workspacePath) {
  const hash = hashWorkspace(workspacePath);
  const dir = path.join(dataDir(), "sessions", hash, "live");
  ensureDir(dir);
  return dir;
}

function activeRunDir(workspacePath) {
  const dir = path.join(getLiveLogDir(workspacePath), "active");
  ensureDir(dir);
  return dir;
}

/**
 * Directory holding human-approval handshake files for the interactive safety mode.
 * The MCP bridge writes <previewId>.json there; the REPL answers with
 * <previewId>.decision.json. They are separate processes with no other IPC channel.
 *
 * @param {string} workspacePath
 * @returns {string}
 */
export function getApprovalDir(workspacePath) {
  const dir = path.join(getLiveLogDir(workspacePath), "approvals");
  ensureDir(dir);
  return dir;
}

export function pruneLiveLogs(workspacePath, maxAgeMs = 24 * 3600 * 1000) {
  try {
    const dir = getLiveLogDir(workspacePath);
    const cutoff = Date.now() - maxAgeMs;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("live-") || !name.endsWith(".log")) continue;
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {
        /* ignore single-file errors */
      }
    }
  } catch {
    /* ignore */
  }
}

export function getLiveLogPath(workspacePath, runId) {
  assertRunId(runId);
  const dir = getLiveLogDir(workspacePath);
  pruneLiveLogs(workspacePath);
  return path.join(dir, `live-${runId}.log`);
}

/**
 * Register an in-flight worker run. Each run owns its own file, so concurrent
 * registrations and clears can never clobber one another.
 */
export function setActiveLiveRun(workspacePath, info) {
  try {
    if (!info || !info.runId) return;
    assertRunId(info.runId);
    atomicWriteJson(path.join(activeRunDir(workspacePath), `${info.runId}.json`), info);
  } catch {
    /* ignore */
  }
}

export function getActiveLiveRun(workspacePath, runId) {
  try {
    const dir = activeRunDir(workspacePath);

    if (runId) {
      assertRunId(runId);
      const file = path.join(dir, `${runId}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }

    const cutoff = Date.now() - ACTIVE_RUN_MAX_AGE_MS;
    let newest = null;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8"));
        if (!rec || !rec.runId) continue;
        // Orphaned registrations from killed processes must not be adopted.
        if (!(typeof rec.timestamp === "number" && rec.timestamp >= cutoff)) continue;
        if (!newest || (rec.timestamp || 0) > (newest.timestamp || 0)) newest = rec;
      } catch {
        continue;
      }
    }
    return newest;
  } catch {
    /* ignore */
  }
  return null;
}

export function clearActiveLiveRun(workspacePath, runId) {
  try {
    const dir = activeRunDir(workspacePath);
    if (runId) {
      assertRunId(runId);
      const file = path.join(dir, `${runId}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return;
    }
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Read a slice of a live worker log starting at a byte offset.
 * Returns the decoded text plus the new offset so callers can poll forward.
 *
 * @param {string} workspacePath
 * @param {string} runId
 * @param {number} [offset=0]
 * @returns {{ text: string, offset: number }}
 */
export function readLiveLogChunk(workspacePath, runId, offset = 0) {
  const file = getLiveLogPath(workspacePath, runId);
  let fd = null;
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { text: "", offset };
    const length = size - offset;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, "r");
    const read = fs.readSync(fd, buf, 0, length, offset);
    return { text: buf.subarray(0, read).toString("utf-8"), offset: offset + read };
  } catch {
    return { text: "", offset };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
