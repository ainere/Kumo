/**
 * history.js — Persistent readline history for Kumo REPL.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HISTORY_FILE = path.join(os.homedir(), ".kumo", "history.txt");
const MAX_HISTORY = 500;

export function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return fs
        .readFileSync(HISTORY_FILE, "utf-8")
        .split("\n")
        .filter(Boolean)
        .slice(-MAX_HISTORY);
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveHistory(lines) {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const trimmed = (lines || []).filter(Boolean).slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, trimmed.join("\n") + "\n", "utf-8");
  } catch {
    /* ignore */
  }
}

/**
 * Strips non-chat commands (lines starting with '/') from persistent history file.
 * Returns the cleaned lines array.
 */
export function cleanHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const current = fs
        .readFileSync(HISTORY_FILE, "utf-8")
        .split("\n")
        .filter(Boolean);
      const cleaned = current.filter((line) => !line.trim().startsWith("/"));
      fs.writeFileSync(HISTORY_FILE, cleaned.length ? cleaned.join("\n") + "\n" : "", "utf-8");
      return cleaned;
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Completely clears the persistent history file.
 */
export function clearHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      fs.unlinkSync(HISTORY_FILE);
    }
  } catch {
    /* ignore */
  }
}
