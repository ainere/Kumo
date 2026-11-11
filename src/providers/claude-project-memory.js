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
 * claude-project-memory.js — the project's CLAUDE.md files, as plain text.
 *
 * Claude Code leads and workers run with `--setting-sources user`, because a
 * project's `.claude/settings.json` can define hooks that run under `-p`. That
 * flag also stops Claude Code reading the project's CLAUDE.md, so this module
 * reads it instead and Kumo hands the text over through the system prompt.
 *
 * Only data crosses: `@import` lines are passed through as text, never
 * expanded, and a file that resolves outside the workspace (a symlink or
 * junction) is left out.
 */

import fs from "node:fs";
import path from "node:path";

/** The project files Claude Code reads from the workspace root, in its order, with a label for the model. */
const MEMORY_FILES = [
  { rel: ["CLAUDE.md"], label: "CLAUDE.md" },
  { rel: [".claude", "CLAUDE.md"], label: ".claude/CLAUDE.md" },
  { rel: ["CLAUDE.local.md"], label: "CLAUDE.local.md" },
];

/** Most project text passed on, in bytes, over all files together. */
export const MAX_PROJECT_MEMORY_BYTES = 64 * 1024;

/**
 * The real path of `file` when it is a regular file that stays inside `rootReal`.
 *
 * @param {string} rootReal
 * @param {string} file
 * @returns {string|null}
 */
function realFileInside(rootReal, file) {
  try {
    const real = fs.realpathSync(file);
    const rel = path.relative(rootReal, real);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Read at most `limit` bytes of a file, and say whether more followed.
 *
 * @param {string} file
 * @param {number} limit
 * @returns {{ text: string, cut: boolean }}
 */
function readCapped(file, limit) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(limit + 1);
    const n = fs.readSync(fd, buf, 0, limit + 1, 0);
    const cut = n > limit;
    // A cut can split a multi-byte character; drop the replacement character it leaves.
    const text = buf.subarray(0, Math.min(n, limit)).toString("utf-8").replace(/�$/, "");
    return { text, cut };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The workspace root's CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md as one
 * labeled block of text for a system prompt, or "" when there is none.
 * Unreadable files are skipped; the text is capped at
 * {@link MAX_PROJECT_MEMORY_BYTES}, with a note when it was cut.
 *
 * @param {string} workspace
 * @returns {string}
 */
export function readProjectMemory(workspace) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(workspace);
  } catch {
    return "";
  }

  let remaining = MAX_PROJECT_MEMORY_BYTES;
  let truncated = false;
  /** @type {string[]} */
  const sections = [];
  for (const { rel, label } of MEMORY_FILES) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const real = realFileInside(rootReal, path.join(rootReal, ...rel));
    if (!real) continue;
    let read;
    try {
      read = readCapped(real, remaining);
    } catch {
      continue;
    }
    if (read.text.trim() === "") continue;
    sections.push(`### ${label}\n${read.text.trimEnd()}`);
    remaining -= Buffer.byteLength(read.text);
    if (read.cut) truncated = true;
  }
  if (sections.length === 0) return "";

  const header =
    "## Project instructions\nThe project's own instruction files follow, passed as plain text. " +
    "Any `@path` import lines in them are not expanded here.";
  const note = truncated ? "\n\n[Project instructions truncated: the size limit of 64 KiB was reached.]" : "";
  return `${header}\n\n${sections.join("\n\n")}${note}`;
}
