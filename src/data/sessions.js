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
 * sessions.js — Multi-chat session persistence and project registry for Kumo.
 *
 * Data layout (root is `KUMO_HOME`, default `~/.kumo`):
 *   <kumoHome>/projects.json       — Global registry: { [pathHash]: { path, name, lastOpened } }
 *   <kumoHome>/sessions/<pathHash>/
 *     ├── chats.json            — Chat index: [{ id, title, createdAt, lastUsedAt, threadId, model, provider, turns }]
 *     │                           (`provider` is set by the chat's first recorded turn: the provider the thread belongs to)
 *     ├── <chatId>.json         — Turn log (JSON lines), one record per successful turn:
 *     │                           { prompt, responseSummary, timestamp, elapsedMs, model, provider,
 *     │                             reasoning?, tools?: [{ toolId, name, role, task, model, effort, ok, elapsedMs, output }],
 *     │                             diffPaths?, replayed? }
 *     │                           reasoning, tools and diffPaths are the turn's trace (see TurnTrace in
 *     │                           core/tool-tracker.js), bounded in size. Older logs lack them and `provider`;
 *     │                           readers must treat all of these as optional.
 *     └── live/
 *         ├── live-<runId>.log  — Raw worker stdout/stderr
 *         └── active/<runId>.json — One file per in-flight worker run
 */

import fs from "node:fs";
import os from "node:os";
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

/**
 * Read projects.json without changing anything.
 *
 * A missing file is an empty registry. A file that cannot be read for any
 * other reason throws: handing back an empty registry there would let the next
 * write replace a registry that is only temporarily out of reach.
 *
 * @returns {{ registry: Record<string, any> } | { corrupt: true }}
 */
function readProjectRegistryFile() {
  let raw;
  try {
    raw = fs.readFileSync(projectsFile(), "utf-8");
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "ENOENT") return { registry: {} };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { corrupt: true };
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { registry: parsed } : { corrupt: true };
}

/**
 * The project registry: `{ [pathHash]: project }`.
 *
 * It holds more than a list of folders (custom names, order, accessible
 * folders), so a registry that does not parse is moved aside, as loadChatIndex
 * does with a chat index, and the next write does not erase it. A read error
 * other than "no such file" is thrown.
 */
export function loadProjectRegistry() {
  const read = readProjectRegistryFile();
  if ("registry" in read) return read.registry;
  const moved = quarantineCorruptFile(projectsFile());
  if (moved) {
    console.warn(`[Warning] Corrupt project registry quarantined at ${moved}`);
  }
  return {};
}

/**
 * Whether a folder is a registered project. Read-only: unlike
 * loadProjectRegistry it never moves a corrupt registry aside, and a registry
 * it cannot read counts as having no projects.
 *
 * @param {string} workspacePath
 * @returns {boolean}
 */
export function isRegisteredProject(workspacePath) {
  try {
    const read = readProjectRegistryFile();
    return "registry" in read && Object.hasOwn(read.registry, hashWorkspace(workspacePath));
  } catch {
    return false;
  }
}

export function registerProject(workspacePath) {
  const resolved = path.resolve(workspacePath);
  const hash = hashWorkspace(resolved);
  const registry = loadProjectRegistry();
  const existing = registry[hash];

  registry[hash] = {
    path: resolved,
    // A name the user gave the project survives reopening it.
    name: existing?.name || path.basename(resolved) || resolved,
    createdAt: existing?.createdAt || existing?.lastOpened || Date.now(),
    order: typeof existing?.order === "number" ? existing.order : (existing?.createdAt || existing?.lastOpened || Date.now()),
    lastOpened: Date.now(),
    accessibleFolders: Array.isArray(existing?.accessibleFolders) ? existing.accessibleFolders : [],
  };

  try {
    atomicWriteJson(projectsFile(), registry);
  } catch {
    /* ignore write errors */
  }

  return registry[hash];
}

export function reorderProjects(orderedPaths) {
  if (!Array.isArray(orderedPaths)) return listProjects();
  const registry = loadProjectRegistry();
  let idx = 0;
  for (const p of orderedPaths) {
    if (typeof p !== "string") continue;
    const resolved = path.resolve(p);
    const hash = hashWorkspace(resolved);
    if (registry[hash]) {
      registry[hash].order = idx++;
    }
  }
  try {
    atomicWriteJson(projectsFile(), registry);
  } catch {
    /* ignore write errors */
  }
  return listProjects();
}

export function renameProject(workspacePath, newName) {
  const resolved = path.resolve(workspacePath);
  const hash = hashWorkspace(resolved);
  const registry = loadProjectRegistry();
  if (!registry[hash]) return listProjects();

  const clean = String(newName || "").trim();
  if (clean) {
    registry[hash].name = clean;
    try {
      atomicWriteJson(projectsFile(), registry);
    } catch {
      /* ignore write errors */
    }
  }
  return listProjects();
}

export function removeProject(workspacePath) {
  const resolved = path.resolve(workspacePath);
  const hash = hashWorkspace(resolved);
  const registry = loadProjectRegistry();
  if (registry[hash]) {
    delete registry[hash];
    try {
      atomicWriteJson(projectsFile(), registry);
    } catch {
      /* ignore write errors */
    }
  }

  // Purge the session directory (chats index, turn files, and live worker logs)
  const sessionDir = getSessionDir(resolved);
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore cleanup errors */
  }

  return listProjects();
}

export function listProjects() {
  const registry = loadProjectRegistry();
  return Object.values(registry)
    .filter((p) => p && typeof p.path === "string" && fs.existsSync(p.path))
    .sort((a, b) => {
      const orderA = typeof a.order === "number" ? a.order : (a.createdAt || a.lastOpened || 0);
      const orderB = typeof b.order === "number" ? b.order : (b.createdAt || b.lastOpened || 0);
      return orderA - orderB;
    });
}

/** Names Windows treats as devices, with or without an extension (`con.txt` is the console). */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Why `name` cannot be the folder name of a new project, or null when it can.
 * The name is one path segment: it never picks a folder other than the one
 * chosen as the parent. The rules are Windows' (the strictest), so a project
 * made on one system can be opened on another.
 *
 * @param {unknown} name
 * @returns {string|null}
 */
export function projectNameProblem(name) {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) return "Project name cannot be empty";
  if (clean === "." || clean === "..") return `'${clean}' is not a valid project name`;
  if (/[\\/:*?"<>|]/.test(clean) || [...clean].some((ch) => ch.charCodeAt(0) < 0x20)) {
    return 'Project name cannot contain any of \\ / : * ? " < > | or control characters';
  }
  if (/[. ]$/.test(clean)) return "Project name cannot end with a dot or a space";
  if (WINDOWS_DEVICE_NAME.test(clean.split(".")[0].trimEnd())) return `'${clean}' is a reserved device name`;
  return null;
}

/**
 * Create a project folder named `name` inside `parentDir`, and register it.
 *
 * `parentDir` must be an absolute path; left out, it is the home directory. A
 * relative one would resolve against this process's working directory, which
 * for the desktop engine is wherever the app was started.
 *
 * @param {string} name - one folder name, see {@link projectNameProblem}
 * @param {string} [parentDir]
 */
export function createProject(name, parentDir) {
  const problem = projectNameProblem(name);
  if (problem) throw new Error(problem);
  const cleanName = String(name).trim();
  if (parentDir !== undefined && parentDir !== null && (typeof parentDir !== "string" || !path.isAbsolute(parentDir))) {
    throw new Error("The folder to create the project in must be an absolute path");
  }
  const base = path.resolve(parentDir ?? os.homedir());
  const targetPath = path.join(base, cleanName);
  ensureDir(targetPath);
  const entry = registerProject(targetPath);
  return { project: entry, path: targetPath, projects: listProjects() };
}

export function setAccessibleFolders(workspacePath, folderPaths) {
  const resolved = path.resolve(workspacePath);
  const hash = hashWorkspace(resolved);
  const registry = loadProjectRegistry();
  if (!registry[hash]) {
    registerProject(resolved);
  }
  const reg = loadProjectRegistry();
  const cleanFolders = (folderPaths || [])
    .map((f) => path.resolve(f))
    .filter((f) => fs.existsSync(f));
  reg[hash].accessibleFolders = Array.from(new Set(cleanFolders));
  try {
    atomicWriteJson(projectsFile(), reg);
  } catch {
    /* ignore write errors */
  }
  return listProjects();
}

export function addAccessibleFolder(workspacePath, folderPath) {
  const resolved = path.resolve(workspacePath);
  const hash = hashWorkspace(resolved);
  const registry = loadProjectRegistry();
  if (!registry[hash]) {
    registerProject(resolved);
  }
  const reg = loadProjectRegistry();
  const folderResolved = path.resolve(folderPath);
  if (!fs.existsSync(folderResolved)) {
    throw new Error(`Directory does not exist: ${folderResolved}`);
  }
  const existing = Array.isArray(reg[hash]?.accessibleFolders) ? reg[hash].accessibleFolders : [];
  if (!existing.some((f) => path.resolve(f) === folderResolved)) {
    reg[hash].accessibleFolders = [...existing, folderResolved];
    try {
      atomicWriteJson(projectsFile(), reg);
    } catch {
      /* ignore write errors */
    }
  }
  return listProjects();
}

export function removeAccessibleFolder(workspacePath, folderPath) {
  const resolved = path.resolve(workspacePath);
  const hash = hashWorkspace(resolved);
  const registry = loadProjectRegistry();
  if (registry[hash] && Array.isArray(registry[hash].accessibleFolders)) {
    const folderResolved = path.resolve(folderPath);
    registry[hash].accessibleFolders = registry[hash].accessibleFolders.filter(
      (f) => path.resolve(f) !== folderResolved
    );
    try {
      atomicWriteJson(projectsFile(), registry);
    } catch {
      /* ignore write errors */
    }
  }
  return listProjects();
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
  if (!chatId) return listChats(workspacePath);
  assertChatId(chatId);
  const chats = loadChatIndex(workspacePath);
  const filtered = chats.filter((c) => c.id !== chatId);
  saveChatIndex(workspacePath, filtered);

  for (const name of [`${chatId}.json`, `${chatId}.plan.json`]) {
    const file = path.join(getSessionDir(workspacePath), name);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    } catch {
      /* ignore */
    }
  }
  return listChats(workspacePath);
}

export function renameChat(workspacePath, chatId, title) {
  if (!chatId) return listChats(workspacePath);
  assertChatId(chatId);
  const clean = String(title || "").trim();
  if (clean) {
    updateChat(workspacePath, chatId, { title: clean });
  }
  return listChats(workspacePath);
}

export function moveChat(fromWorkspace, toWorkspace, chatId) {
  if (!chatId) return { ok: false, error: "Missing chatId" };
  assertChatId(chatId);
  const fromResolved = path.resolve(fromWorkspace);
  const toResolved = path.resolve(toWorkspace);
  if (fromResolved.toLowerCase() === toResolved.toLowerCase()) {
    return { ok: true };
  }

  const fromChats = loadChatIndex(fromResolved);
  const chatIdx = fromChats.findIndex((c) => c.id === chatId);
  if (chatIdx === -1) {
    return { ok: false, error: `Chat ${chatId} not found in source workspace` };
  }

  const [chat] = fromChats.splice(chatIdx, 1);

  // Order matters: the history is copied first, then the destination index
  // gains the chat, then the source index drops it. A failure at any step
  // leaves the chat reachable where it was (or in both places), never in
  // neither, and the error reaches the caller.
  const toDir = getSessionDir(toResolved);
  ensureDir(toDir);
  const fromFile = path.join(getSessionDir(fromResolved), `${chatId}.json`);
  const toFile = path.join(toDir, `${chatId}.json`);
  const hasLog = fs.existsSync(fromFile);
  if (hasLog) fs.copyFileSync(fromFile, toFile);
  const fromPlan = path.join(getSessionDir(fromResolved), `${chatId}.plan.json`);
  const hasPlan = fs.existsSync(fromPlan);
  if (hasPlan) fs.copyFileSync(fromPlan, path.join(toDir, `${chatId}.plan.json`));

  // A retry after a partial move finds the chat in the destination already.
  const toChats = loadChatIndex(toResolved).filter((c) => c.id !== chatId);
  toChats.unshift(chat);
  saveChatIndex(toResolved, toChats);
  saveChatIndex(fromResolved, fromChats);

  // The move is done; a leftover source file is only clutter, so it is reported, not thrown.
  for (const file of [...(hasLog ? [fromFile] : []), ...(hasPlan ? [fromPlan] : [])]) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      console.warn(`[Warning] Moved chat ${chatId}, but could not remove its old file ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { ok: true };
}

export function reorderChats(workspacePath, orderedIds) {
  if (!Array.isArray(orderedIds)) return listChats(workspacePath);
  const chats = loadChatIndex(workspacePath);
  const map = new Map(chats.map((c) => [c.id, c]));
  let idx = 0;
  for (const id of orderedIds) {
    const c = map.get(id);
    if (c) {
      c.order = idx++;
    }
  }
  saveChatIndex(workspacePath, chats);
  return listChats(workspacePath);
}

export function listChats(workspacePath) {
  const chats = loadChatIndex(workspacePath);
  return chats.sort((a, b) => {
    if (typeof a.order === "number" && typeof b.order === "number") {
      return a.order - b.order;
    }
    if (typeof a.order === "number") return -1;
    if (typeof b.order === "number") return 1;
    return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
  });
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
