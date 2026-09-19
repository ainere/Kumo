/**
 * history.js — Persistent readline history for Kumo REPL.
 */
import fs from "node:fs";
import path from "node:path";
import { kumoHome, atomicWriteText } from "../config/paths.js";

const MAX_HISTORY = 500;

function historyFile() {
  return path.join(kumoHome(), "history.txt");
}

export function loadHistory() {
  try {
    const file = historyFile();
    if (fs.existsSync(file)) {
      return fs
        .readFileSync(file, "utf-8")
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
    const trimmed = (lines || []).filter(Boolean).slice(-MAX_HISTORY);
    atomicWriteText(historyFile(), trimmed.join("\n") + "\n");
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
    const file = historyFile();
    if (fs.existsSync(file)) {
      const current = fs
        .readFileSync(file, "utf-8")
        .split("\n")
        .filter(Boolean);
      const cleaned = current.filter((line) => !line.trim().startsWith("/"));
      atomicWriteText(file, cleaned.length ? cleaned.join("\n") + "\n" : "");
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
    const file = historyFile();
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    /* ignore */
  }
}
