/**
 * sessions.js — Multi-chat session persistence and project registry for Kumo.
 *
 * Data layout:
 *   ~/.kumo/projects.json       — Global registry: { [pathHash]: { path, name, lastOpened } }
 *   ~/.kumo/sessions/<pathHash>/
 *     ├── chats.json            — Chat index: [{ id, title, createdAt, lastUsedAt, threadId, model, turns }]
 *     └── <chatId>.json         — Turn log (JSON lines): { prompt, responseSummary, timestamp, model, elapsedMs }
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const DATA_DIR = path.join(os.homedir(), ".kumo");
const PROJECTS_FILE = path.join(DATA_DIR, "projects.json");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Validate a chat id (prevents path traversal via `../../evil` ids).
 *
 * @param {string} chatId
 */
function assertChatId(chatId) {
  if (!CHAT_ID_RE.test(chatId || "")) {
    throw new Error("Invalid chatId");
  }
}

/**
 * Atomically write JSON (tmp file + rename; never leaves a truncated target).
 *
 * @param {string} file
 * @param {*} data
 */
function atomicWriteJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

// ── Project Registry ──

export function hashWorkspace(workspacePath) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(workspacePath).toLowerCase())
    .digest("hex")
    .slice(0, 12);
}

export function loadProjectRegistry() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
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
    atomicWriteJson(PROJECTS_FILE, registry);
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
  return path.join(DATA_DIR, "sessions", hashWorkspace(workspacePath));
}

export function loadChatIndex(workspacePath) {
  const dir = getSessionDir(workspacePath);
  const file = path.join(dir, "chats.json");
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  } catch {
    /* ignore corrupt index */
  }
  return [];
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
    fs.appendFileSync(file, JSON.stringify(turn) + "\n", "utf-8");
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
  const dir = path.join(DATA_DIR, "sessions", hash, "live");
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
  const dir = getLiveLogDir(workspacePath);
  pruneLiveLogs(workspacePath);
  return path.join(dir, `live-${runId}.log`);
}

export function setActiveLiveRun(workspacePath, info) {
  try {
    const dir = getLiveLogDir(workspacePath);
    const activeFile = path.join(dir, "active.json");
    let runs = {};
    if (fs.existsSync(activeFile)) {
      try {
        runs = JSON.parse(fs.readFileSync(activeFile, "utf-8"));
      } catch {}
    }
    if (runs.runId && !runs[runs.runId]) {
      runs = { [runs.runId]: runs };
    }
    if (info && info.runId) {
      runs[info.runId] = info;
    }
    atomicWriteJson(activeFile, runs);
  } catch {
    /* ignore */
  }
}

export function getActiveLiveRun(workspacePath, runId) {
  try {
    const dir = getLiveLogDir(workspacePath);
    const activeFile = path.join(dir, "active.json");
    if (fs.existsSync(activeFile)) {
      const data = JSON.parse(fs.readFileSync(activeFile, "utf-8"));
      if (runId) {
        if (data.runId === runId) return data;
        return data[runId] || null;
      }
      if (data.runId) return data;
      const keys = Object.keys(data);
      if (keys.length > 0) {
        keys.sort((a, b) => (data[b].timestamp || 0) - (data[a].timestamp || 0));
        return data[keys[0]];
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearActiveLiveRun(workspacePath, runId) {
  try {
    const dir = getLiveLogDir(workspacePath);
    const activeFile = path.join(dir, "active.json");
    if (fs.existsSync(activeFile)) {
      const data = JSON.parse(fs.readFileSync(activeFile, "utf-8"));
      if (data.runId && (!runId || data.runId === runId)) {
        fs.unlinkSync(activeFile);
        return;
      }
      if (runId && data[runId]) {
        delete data[runId];
      } else if (!runId) {
        for (const k of Object.keys(data)) delete data[k];
      }
      if (Object.keys(data).length === 0) {
        fs.unlinkSync(activeFile);
      } else {
        atomicWriteJson(activeFile, data);
      }
    }
  } catch {
    /* ignore */
  }
}
