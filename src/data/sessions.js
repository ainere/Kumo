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
    ensureDir(DATA_DIR);
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(registry, null, 2), "utf-8");
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
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, "chats.json"), JSON.stringify(chats, null, 2), "utf-8");
}

export function createChat(workspacePath, opts = {}) {
  const dir = getSessionDir(workspacePath);
  ensureDir(dir);

  const chats = loadChatIndex(workspacePath);
  const chatId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

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
  const chats = loadChatIndex(workspacePath);
  const idx = chats.findIndex((c) => c.id === chatId);
  if (idx === -1) return false;

  chats[idx] = { ...chats[idx], ...updates };
  saveChatIndex(workspacePath, chats);
  return true;
}

export function deleteChat(workspacePath, chatId) {
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
  const dir = getSessionDir(workspacePath);
  const file = path.join(dir, `${chatId}.json`);
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, "utf-8");
      return content
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((line) => JSON.parse(line));
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
