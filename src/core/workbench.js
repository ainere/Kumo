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
 * workbench.js — What the desktop Workbench reads from a project.
 *
 * Files and diffs come from git when the folder is a repository, so the tree
 * matches what the project tracks. File reads stay inside the workspace, links
 * included. Also here: a real terminal per workspace, localhost dev-server
 * detection, and each chat's plan.
 *
 * The engine serves running turns from this same process, so nothing here may
 * block for long: git and directory walks are async.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { atomicWriteJson } from "../config/paths.js";
import { getSessionDir, loadTurnLog } from "../data/sessions.js";
import { resolveBinary, safeSpawn } from "../utils/process.js";

/** Folders left out of the tree when git isn't deciding what belongs to the project. */
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  ".kumo",
  ".cache",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "target",
]);

const DEFAULT_MAX_FILES = 5000;
const HARD_MAX_FILES = 5000;
/** How many directory entries a walk looks at before giving up on a huge folder. */
const MAX_WALK_ENTRIES = 100_000;
const MAX_READ_BYTES = 512 * 1024;
const MAX_UNTRACKED_DIFF_BYTES = 64 * 1024;
const MAX_UNTRACKED_DIFF_FILES = 50;
const MAX_DIFF_FILES = 500;
const MAX_DIFF_LINES_PER_FILE = 2000;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const TERMINAL_BUFFER = 256 * 1024;
const TERMINAL_FLUSH_MS = 12;
const MAX_PLAN_TEXT = 500;
const MAX_PLAN_ITEMS = 200;

/** git's well-known empty tree: the base for a diff in a repository with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Every git call here runs by itself as soon as a project opens, and a folder's
 * own `.git/config` can name commands for git to run. A downloaded project
 * mustn't get code execution just by being looked at, so these turn off what
 * would run one, and `autoRefreshIndex` keeps a background diff from writing
 * the index under a worker's `git add`. See also {@link localFilterOverrides}.
 */
const GIT_SAFE_CONFIG = ["-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

export const DEFAULT_LOCALHOST_PORTS = /** @type {const} */ ([3000, 4173, 4200, 5173, 8000, 8080, 8888]);

/**
 * Resolve real path of a directory or file, falling back to `path.resolve` if
 * native realpath is unsupported on the volume.
 *
 * @param {string} p
 * @returns {string}
 */
function realpathSafe(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }
}

/**
 * Check whether `candidate` resolves inside `rootReal`.
 *
 * @param {string} rootReal
 * @param {string} candidate
 * @returns {boolean}
 */
function isInsideRoot(rootReal, candidate) {
  const rel = path.relative(rootReal, candidate);
  if (!rel) return true;
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  if (process.platform === "win32" && rel.includes(":")) return false;
  return true;
}

/**
 * Normalize a relative path to forward-slash POSIX form.
 *
 * @param {string} rel
 * @returns {string}
 */
function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

/** @param {string} rel */
const inIgnoredDir = (rel) => rel.split("/").some((part) => IGNORED_DIRS.has(part));

/** @param {string} text */
const splitNul = (text) => text.split("\0").filter(Boolean);

/**
 * Run git in `cwd`. Output past `maxBytes` is cut off and flagged, so a huge
 * diff reports itself instead of failing or being dropped silently.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [maxBytes]
 * @returns {Promise<{ ok: boolean, stdout: string, truncated: boolean }>}
 */
function runGit(cwd, args, maxBytes = MAX_GIT_OUTPUT) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let truncated = false;
    const proc = safeSpawn("git", [...GIT_SAFE_CONFIG, ...args], {
      cwd,
      // The engine has no console: without this, each call flashes one on Windows.
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => proc.kill(), GIT_TIMEOUT_MS);
    /** @param {boolean} ok */
    const finish = (ok) => {
      clearTimeout(timer);
      resolve({ ok, stdout: Buffer.concat(chunks).toString("utf-8"), truncated });
    };
    proc.stdout?.on("data", (/** @type {Buffer} */ chunk) => {
      if (truncated) return;
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
        proc.kill();
        return;
      }
      chunks.push(chunk);
    });
    proc.on("error", () => finish(false));
    proc.on("close", (code) => finish(code === 0 || truncated));
  });
}

/**
 * @typedef {{
 *   path: string,
 *   name: string,
 *   kind: "file" | "dir",
 * }} WorkspaceFileEntry
 */

/**
 * New files git isn't ignoring, minus heavy folders and anything reached
 * through a link: git walks a Windows junction as if it were a folder, so
 * without this the listing runs outside the project or round a loop forever.
 * Null outside a repository.
 *
 * @param {string} rootReal
 * @returns {Promise<string[] | null>}
 */
async function listUntracked(rootReal) {
  const res = await runGit(rootReal, ["ls-files", "-o", "--exclude-standard", "-z"]);
  if (!res.ok) return null;
  /** @type {Map<string, Promise<boolean>>} */
  const checked = new Map();
  /** @param {string} dir */
  const throughLink = (dir) => {
    let verdict = checked.get(dir);
    if (!verdict) {
      const parent = path.posix.dirname(dir);
      verdict = (async () => {
        if (parent !== "." && (await throughLink(parent))) return true;
        const stat = await fs.promises.lstat(path.join(rootReal, dir)).catch(() => null);
        return Boolean(stat?.isSymbolicLink());
      })();
      checked.set(dir, verdict);
    }
    return verdict;
  };
  const candidates = splitNul(res.stdout).filter((p) => !inIgnoredDir(p));
  const linked = await Promise.all(
    candidates.map((p) => {
      const dir = path.posix.dirname(p);
      return dir === "." ? false : throughLink(dir);
    })
  );
  return candidates.filter((_, i) => !linked[i]);
}

/**
 * What git says belongs to this folder: tracked files that still exist, plus
 * untracked ones that aren't ignored. Null outside a repository.
 *
 * @param {string} rootReal
 * @returns {Promise<string[] | null>}
 */
async function listGitPaths(rootReal) {
  const [tracked, untracked, deleted] = await Promise.all([
    runGit(rootReal, ["ls-files", "-c", "-z"]),
    listUntracked(rootReal),
    runGit(rootReal, ["ls-files", "-d", "-z"]),
  ]);
  if (!tracked.ok || !untracked) return null;
  const gone = new Set(splitNul(deleted.stdout));
  const paths = new Set(splitNul(tracked.stdout).filter((p) => !gone.has(p)));
  // Tracked files show even in a folder like build/; an untracked one has to earn it.
  for (const p of untracked) paths.add(p);
  return [...paths];
}

/**
 * Walk a folder breadth first, so a cap keeps the top of the tree. Each real
 * directory is visited once, and links leading outside the root are skipped.
 *
 * @param {string} rootReal
 * @param {string} query - lower-case substring a path has to contain, or ""
 * @param {number} limit - stop after one path more than this
 * @returns {Promise<string[]>}
 */
async function walkPaths(rootReal, query, limit) {
  /** @type {string[]} */
  const found = [];
  const visited = new Set([rootReal]);
  /** @type {Array<{ abs: string, rel: string }>} */
  let level = [{ abs: rootReal, rel: "" }];
  let scanned = 0;

  while (level.length > 0) {
    /** @type {Array<{ abs: string, rel: string }>} */
    const next = [];
    for (const dir of level) {
      const entries = await fs.promises.readdir(dir.abs, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (++scanned > MAX_WALK_ENTRIES || found.length > limit) return found;
        const abs = path.join(dir.abs, entry.name);
        const rel = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
        let isDir = entry.isDirectory();
        let real = abs;
        if (entry.isSymbolicLink()) {
          real = realpathSafe(abs);
          if (!isInsideRoot(rootReal, real)) continue;
          const stat = await fs.promises.stat(real).catch(() => null);
          if (!stat) continue;
          isDir = stat.isDirectory();
        }
        if (isDir) {
          if (IGNORED_DIRS.has(entry.name) || visited.has(real)) continue;
          visited.add(real);
          next.push({ abs, rel });
        } else if (!query || rel.toLowerCase().includes(query)) {
          found.push(rel);
        }
      }
    }
    level = next;
  }
  return found;
}

/**
 * Lay file paths out as a tree in reading order: at each level folders first,
 * then files, each by name.
 *
 * @param {string[]} paths
 * @returns {WorkspaceFileEntry[]}
 */
function toTreeEntries(paths) {
  /** @typedef {{ dirs: Map<string, TreeNode>, files: string[] }} TreeNode */
  /** @type {TreeNode} */
  const root = { dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    const name = /** @type {string} */ (parts.pop());
    let node = root;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(name);
  }

  /** @type {WorkspaceFileEntry[]} */
  const out = [];
  /** @param {string} a @param {string} b */
  const byName = (a, b) => a.localeCompare(b);
  /**
   * @param {TreeNode} node
   * @param {string} prefix
   */
  const emit = (node, prefix) => {
    for (const name of [...node.dirs.keys()].sort(byName)) {
      const dirPath = prefix ? `${prefix}/${name}` : name;
      out.push({ path: dirPath, name, kind: "dir" });
      emit(/** @type {TreeNode} */ (node.dirs.get(name)), dirPath);
    }
    for (const name of [...node.files].sort(byName)) {
      out.push({ path: prefix ? `${prefix}/${name}` : name, name, kind: "file" });
    }
  };
  emit(root, "");
  return out;
}

/**
 * List the files in `workspace`. Past the cap the shallowest paths stay, so
 * one enormous folder can't hide the rest of the project; `query` searches
 * everything, capped or not.
 *
 * @param {string} workspace
 * @param {{ query?: string, maxFiles?: number }} [opts]
 * @returns {Promise<{ workspace: string, files: WorkspaceFileEntry[], truncated: boolean }>}
 */
export async function listWorkspaceFiles(workspace, opts = {}) {
  const rootReal = realpathSafe(workspace);
  const limit = Math.min(Math.max(1, opts.maxFiles ?? DEFAULT_MAX_FILES), HARD_MAX_FILES);
  const query = (opts.query ?? "").trim().toLowerCase();

  const gitPaths = await listGitPaths(rootReal);
  const matching = gitPaths
    ? gitPaths.filter((p) => !query || p.toLowerCase().includes(query))
    : await walkPaths(rootReal, query, limit);

  const truncated = matching.length > limit;
  const kept = truncated
    ? matching
        .map((p) => ({ p, depth: p.split("/").length }))
        .sort((a, b) => a.depth - b.depth || (a.p < b.p ? -1 : 1))
        .slice(0, limit)
        .map(({ p }) => p)
    : matching;

  const files = query
    ? toTreeEntries(kept).filter((entry) => entry.kind === "file")
    : toTreeEntries(kept);
  return { workspace: rootReal, files, truncated };
}

/**
 * Safely read a single text file inside `workspace`.
 *
 * @param {string} workspace
 * @param {string} relPath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{
 *   path: string,
 *   content: string,
 *   size: number,
 *   mtime: number,
 *   binary: boolean,
 *   truncated: boolean,
 *   totalLines: number,
 * }}
 */
export function readWorkspaceFile(workspace, relPath, opts = {}) {
  const cleanRel = String(relPath ?? "").trim();
  if (!cleanRel || cleanRel.includes("\0")) {
    throw new Error("Invalid file path.");
  }
  if (path.isAbsolute(cleanRel) || /^[A-Za-z]:/.test(cleanRel) || cleanRel.startsWith("/") || cleanRel.startsWith("\\")) {
    throw new Error("File path must be relative to the workspace.");
  }
  const normalized = toPosix(path.normalize(cleanRel));
  if (normalized.split("/").includes("..")) {
    throw new Error(`'${relPath}' is outside the allowed workspace scope.`);
  }
  if (process.platform === "win32" && normalized.includes(":")) {
    throw new Error(`'${relPath}' is not a plain file path.`);
  }

  const rootReal = realpathSafe(workspace);
  const candidate = path.resolve(rootReal, normalized);
  if (!isInsideRoot(rootReal, candidate)) {
    throw new Error(`'${relPath}' is outside the workspace.`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`File '${normalized}' was not found.`);
  }

  // The whole chain, not just the last step: a link anywhere along the path can
  // lead out of the workspace. The real path also settles spelling, so .GIT
  // can't pass for something other than .git on a case-insensitive disk.
  const resolved = realpathSafe(candidate);
  if (!isInsideRoot(rootReal, resolved)) {
    throw new Error(`'${relPath}' points outside the workspace.`);
  }
  if (toPosix(path.relative(rootReal, resolved)).split("/").some((part) => part.toLowerCase() === ".git")) {
    throw new Error(`'${relPath}' is outside the allowed workspace scope.`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`'${normalized}' is not a regular file.`);
  }

  const maxBytes = Math.min(Math.max(1024, opts.maxBytes ?? MAX_READ_BYTES), MAX_READ_BYTES * 2);
  const readLen = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readLen);
  const fd = fs.openSync(resolved, "r");
  try {
    fs.readSync(fd, buf, 0, readLen, 0);
  } finally {
    fs.closeSync(fd);
  }

  const binary = buf.subarray(0, Math.min(buf.length, 8192)).includes(0);
  if (binary) {
    return {
      path: normalized,
      content: "",
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs || 0),
      binary: true,
      truncated: stat.size > readLen,
      totalLines: 0,
    };
  }

  const content = buf.toString("utf-8");
  return {
    path: normalized,
    content,
    size: stat.size,
    mtime: Math.floor(stat.mtimeMs || 0),
    binary: false,
    truncated: stat.size > readLen,
    totalLines: splitLines(content).length,
  };
}

/**
 * A file's lines; the newline ending the last one doesn't start another.
 *
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * @typedef {{
 *   type: "add" | "del" | "context",
 *   oldLine: number | null,
 *   newLine: number | null,
 *   text: string,
 * }} DiffLine
 *
 * @typedef {{
 *   header: string,
 *   lines: DiffLine[],
 * }} DiffHunk
 *
 * @typedef {{
 *   path: string,
 *   oldPath?: string,
 *   status: "modified" | "added" | "deleted" | "untracked" | "renamed",
 *   additions: number,
 *   deletions: number,
 *   hunks: DiffHunk[],
 *   note?: string,
 * }} DiffFile
 */

/**
 * Undo git's C-style quoting of an unusual path.
 *
 * @param {string} raw
 * @returns {string}
 */
function unquoteGitPath(raw) {
  if (!/^".*"$/.test(raw)) return raw;
  const chars = [...raw.slice(1, -1)];
  /** @type {number[]} */
  const bytes = [];
  /** @type {Record<string, number>} */
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...Buffer.from(chars[i], "utf-8"));
      continue;
    }
    const next = chars[++i];
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(chars.slice(i, i + 3).join(""), 8));
      i += 2;
    } else {
      bytes.push(escapes[next] ?? next.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf-8");
}

/**
 * The new path out of a `diff --git a/x b/x` header. The sides aren't marked,
 * so a path holding " b/" is told apart by the two sides being the same length.
 *
 * @param {string} rest - the header after "diff --git "
 * @returns {string}
 */
function headerPath(rest) {
  const quoted = /"(?:[^"\\]|\\.)*"$/.exec(rest);
  if (quoted) return unquoteGitPath(quoted[0]).replace(/^b\//, "");
  const mid = (rest.length - 1) / 2;
  if (Number.isInteger(mid) && rest[mid] === " ") return rest.slice(mid + 3);
  const match = /^a\/.+? b\/(.+)$/.exec(rest);
  return match ? match[1] : rest;
}

/**
 * The path on a `--- ` or `+++ ` line.
 *
 * @param {string} line
 * @returns {string}
 */
function markerPath(line) {
  const raw = unquoteGitPath(line.slice(4).split("\t")[0].trim());
  return raw === "/dev/null" ? raw : raw.replace(/^[ab]\//, "");
}

/**
 * Parse a unified git diff into files, hunks and numbered lines.
 *
 * A hunk's header says how many lines it holds, and only that count tells a
 * body from the next header: deleting the SQL comment `-- x` reads `--- x`,
 * which looks just like a file marker.
 *
 * @param {string} diffText
 * @returns {DiffFile[]}
 */
export function parseUnifiedDiff(diffText) {
  if (!diffText || !diffText.trim()) return [];
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let file = null;
  /** @type {DiffHunk | null} */
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  /** @param {string} filePath */
  const startFile = (filePath) => {
    const next = /** @type {DiffFile} */ ({ path: filePath, status: "modified", additions: 0, deletions: 0, hunks: [] });
    files.push(next);
    hunk = null;
    return next;
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (file && hunk && (oldLeft > 0 || newLeft > 0)) {
      const { lines } = /** @type {DiffHunk} */ (hunk);
      if (line.startsWith("+")) {
        lines.push({ type: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
        file.additions++;
        newLeft--;
      } else if (line.startsWith("-")) {
        lines.push({ type: "del", oldLine: oldLine++, newLine: null, text: line.slice(1) });
        file.deletions++;
        oldLeft--;
      } else if (!line.startsWith("\\")) {
        // "\ No newline at end of file" isn't a line of the file.
        lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) });
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      file = startFile(headerPath(line.slice("diff --git ".length)));
      continue;
    }

    // A plain patch has no `diff --git` line: its `---` starts the next file.
    if (line.startsWith("--- ")) {
      const oldPath = markerPath(line);
      if (!file || file.hunks.length > 0) file = startFile(oldPath);
      if (oldPath === "/dev/null") file.status = "added";
      continue;
    }
    if (!file) continue;

    if (line.startsWith("+++ ")) {
      const newPath = markerPath(line);
      if (newPath === "/dev/null") file.status = "deleted";
      else file.path = newPath;
      continue;
    }
    if (line.startsWith("new file mode")) {
      file.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = unquoteGitPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      file.path = unquoteGitPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("Binary files ")) {
      file.note = "Binary file.";
      continue;
    }

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      oldLine = parseInt(header[1], 10);
      oldLeft = header[2] === undefined ? 1 : parseInt(header[2], 10);
      newLine = parseInt(header[3], 10);
      newLeft = header[4] === undefined ? 1 : parseInt(header[4], 10);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    }
  }

  for (const parsed of files) {
    if (parsed.hunks.length > 0 || parsed.note) continue;
    parsed.note = parsed.status === "renamed" ? "Renamed with no content changes." : "No text changes.";
  }
  return files;
}

/**
 * Keep one file's hunks to what the window can draw. Its +/- counts stay whole.
 *
 * @param {DiffFile} file
 */
function capDiffLines(file) {
  let left = MAX_DIFF_LINES_PER_FILE;
  /** @type {DiffHunk[]} */
  const kept = [];
  for (const hunk of file.hunks) {
    if (left <= 0) break;
    kept.push(hunk.lines.length > left ? { ...hunk, lines: hunk.lines.slice(0, left) } : hunk);
    left -= hunk.lines.length;
  }
  if (left < 0 || kept.length < file.hunks.length) {
    file.hunks = kept;
    file.note = `Large diff: showing the first ${MAX_DIFF_LINES_PER_FILE.toLocaleString("en-US")} lines.`;
  }
}

/**
 * An untracked file as a diff of all-added lines.
 *
 * @param {string} rootReal
 * @param {string} rel
 * @returns {DiffFile}
 */
function untrackedDiff(rootReal, rel) {
  /** @type {DiffFile} */
  const entry = { path: rel, status: "untracked", additions: 0, deletions: 0, hunks: [] };
  try {
    const data = readWorkspaceFile(rootReal, rel, { maxBytes: MAX_UNTRACKED_DIFF_BYTES });
    if (data.binary) {
      entry.note = "Binary file.";
      return entry;
    }
    const lines = splitLines(data.content).map((text, i) => ({
      type: /** @type {const} */ ("add"),
      oldLine: null,
      newLine: i + 1,
      text,
    }));
    entry.additions = lines.length;
    if (lines.length > 0) entry.hunks = [{ header: `@@ -0,0 +1,${lines.length} @@`, lines }];
    if (data.truncated) entry.note = `Large file: showing the first ${MAX_UNTRACKED_DIFF_BYTES / 1024} KB.`;
    capDiffLines(entry);
  } catch {
    entry.note = "Couldn't read this file.";
  }
  return entry;
}

/**
 * `git diff` runs clean filters on changed files, and a repository can define
 * its own, so filters from inside the folder are switched off for this call.
 * The user's own (global and system, like Git LFS) stay. The cost: a repository
 * whose filter lives only in its `.git/config`, as git-crypt's does, shows the
 * filtered files as changed here.
 *
 * @param {string} rootReal
 * @returns {Promise<string[]>}
 */
async function localFilterOverrides(rootReal) {
  const res = await runGit(rootReal, ["config", "--show-scope", "--name-only", "--get-regexp", "^filter\\."]);
  /** @type {Set<string>} */
  const drivers = new Set();
  for (const line of res.stdout.split(/\r?\n/)) {
    const [scope, key] = line.split("\t");
    if (!key || scope === "global" || scope === "system") continue;
    const driver = /^filter\.(.+)\.[^.]+$/.exec(key)?.[1];
    if (driver) drivers.add(driver);
  }
  return [...drivers].flatMap((driver) =>
    [`clean=`, `smudge=`, `process=`, `required=false`].flatMap((setting) => ["-c", `filter.${driver}.${setting}`])
  );
}

/**
 * The workspace's uncommitted changes: tracked files against HEAD and untracked
 * files as new. Paths are relative to `workspace`, which may be a subfolder of
 * the repository, and changes outside it are left out.
 *
 * @param {string} workspace
 * @returns {Promise<{ git: boolean, files: DiffFile[], truncated: boolean }>}
 */
export async function getWorkspaceDiff(workspace) {
  const rootReal = realpathSafe(workspace);
  const inRepo = await runGit(rootReal, ["rev-parse", "--is-inside-work-tree"]);
  if (!inRepo.ok || inRepo.stdout.trim() !== "true") return { git: false, files: [], truncated: false };

  const [head, filters] = await Promise.all([
    runGit(rootReal, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    localFilterOverrides(rootReal),
  ]);
  const diff = await runGit(rootReal, [
    ...filters,
    "diff",
    head.ok ? "HEAD" : EMPTY_TREE,
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--relative",
    "--find-renames",
    "--unified=3",
    // Whatever the user's git config says, the parser needs these prefixes.
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]);

  const files = parseUnifiedDiff(diff.stdout);
  // A diff that stopped partway (too much output, or git timing out) isn't the whole picture.
  let truncated = diff.truncated || !diff.ok;
  for (const file of files) capDiffLines(file);

  const seen = new Set(files.map((f) => f.path));
  let previews = 0;
  for (const rel of (await listUntracked(rootReal)) ?? []) {
    if (seen.has(rel)) continue;
    if (files.length >= MAX_DIFF_FILES) {
      truncated = true;
      break;
    }
    if (previews >= MAX_UNTRACKED_DIFF_FILES) {
      files.push({ path: rel, status: "untracked", additions: 0, deletions: 0, hunks: [], note: "New file." });
      continue;
    }
    previews++;
    files.push(untrackedDiff(rootReal, rel));
  }

  return { git: true, files, truncated };
}

/** The shell a new terminal runs: PowerShell 7 where it's installed, else Windows PowerShell or $SHELL. */
function defaultShell() {
  if (process.platform !== "win32") return process.env.SHELL || "/bin/sh";
  const pwsh = resolveBinary("pwsh");
  return pwsh && path.isAbsolute(pwsh) ? pwsh : "powershell.exe";
}

/** The user's environment, minus what only made sense for the app starting the engine. */
function terminalEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^ELECTRON_|^KUMO_(ENGINE_ROOT|E2E)/i.test(key)) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

/**
 * node-pty is native and optional, so the engine loads without it. The name
 * isn't a literal: type checks and bundlers leave a dependency that may be
 * missing alone.
 */
async function loadPty() {
  const name = "node-pty";
  try {
    return await import(name);
  } catch (err) {
    throw new Error(`The terminal needs node-pty, which couldn't load here: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * @typedef {{
 *   id: string,
 *   workspace: string,
 *   shell: string,
 *   pty: any,
 *   buffer: string,
 *   pending: string,
 *   timer: ReturnType<typeof setTimeout> | null,
 *   exitCode: number | null,
 * }} TerminalRecord
 */

/**
 * One real shell per workspace, running in a pty. A terminal outlives the tab
 * that shows it: the shell keeps running (a dev server, say) while the
 * Workbench shows something else, and a tab coming back replays what it missed
 * from a buffer. Output goes out as events, in small batches so a chatty
 * command can't flood the window.
 */
export class TerminalManager {
  /** @param {(type: "terminal.output" | "terminal.exit", payload: Record<string, unknown>) => void} emit */
  constructor(emit) {
    this.emit = emit;
    /** @type {Map<string, TerminalRecord>} */
    this.terminals = new Map();
  }

  /**
   * The workspace's terminal, started if it isn't running.
   *
   * @param {string} workspace
   * @param {{ cols: number, rows: number }} size
   */
  async open(workspace, size) {
    const { spawn } = await loadPty();
    const rootReal = realpathSafe(workspace);
    const id = `term-${createHash("sha1").update(rootReal).digest("hex").slice(0, 16)}`;
    const existing = this.terminals.get(id);
    if (existing && existing.exitCode === null) {
      this.resize(id, size);
      return this._snapshot(existing);
    }

    // Checked first: node-pty leaves its worker thread running when a spawn fails.
    if (!fs.statSync(rootReal, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`The project folder is gone: ${rootReal}`);
    }
    const shell = defaultShell();
    const pty = spawn(shell, [], {
      name: "xterm-256color",
      cols: size.cols,
      rows: size.rows,
      cwd: rootReal,
      env: terminalEnv(),
    });
    /** @type {TerminalRecord} */
    const record = { id, workspace: rootReal, shell, pty, buffer: "", pending: "", timer: null, exitCode: null };
    this.terminals.set(id, record);
    record.pty.onData((/** @type {string} */ data) => this._output(record, data));
    record.pty.onExit((/** @type {{ exitCode: number }} */ { exitCode }) => {
      // A restarted terminal keeps its id: the old shell going away is no news.
      if (this.terminals.get(id) !== record) return;
      this._flush(record);
      record.exitCode = exitCode ?? 0;
      this._release(record);
      this.emit("terminal.exit", { terminalId: id, exitCode: record.exitCode });
    });
    return this._snapshot(record);
  }

  /**
   * @param {string} id
   * @param {string} data
   */
  input(id, data) {
    const record = this.terminals.get(id);
    if (record && record.exitCode === null) record.pty.write(data);
  }

  /**
   * @param {string} id
   * @param {{ cols: number, rows: number }} size
   */
  resize(id, size) {
    const record = this.terminals.get(id);
    if (!record || record.exitCode !== null) return;
    try {
      record.pty.resize(size.cols, size.rows);
    } catch {
      /* the shell exited between the check and the call */
    }
  }

  /**
   * Stop the workspace's shell and start a fresh one.
   *
   * @param {string} workspace
   * @param {{ cols: number, rows: number }} size
   */
  async restart(workspace, size) {
    const rootReal = realpathSafe(workspace);
    for (const record of this.terminals.values()) {
      if (record.workspace === rootReal) this._kill(record);
    }
    return this.open(rootReal, size);
  }

  /** Stop every shell. */
  closeAll() {
    for (const record of [...this.terminals.values()]) this._kill(record);
  }

  /** @param {TerminalRecord} record */
  _kill(record) {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    record.pending = "";
    this.terminals.delete(record.id);
    if (record.exitCode === null) this._release(record);
  }

  /**
   * Let go of the pty. A shell that ended on its own still needs this: node-pty
   * holds its pipes and a worker thread until told, and the engine runs for days.
   *
   * @param {TerminalRecord} record
   */
  _release(record) {
    try {
      record.pty.kill();
    } catch {
      /* already gone */
    }
  }

  /**
   * @param {TerminalRecord} record
   * @param {string} data
   */
  _output(record, data) {
    // A replaced shell's last words mustn't land in the new one's screen.
    if (this.terminals.get(record.id) !== record) return;
    record.pending += data;
    record.timer ??= setTimeout(() => this._flush(record), TERMINAL_FLUSH_MS);
  }

  /** @param {TerminalRecord} record */
  _flush(record) {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    if (!record.pending) return;
    const data = record.pending;
    record.pending = "";
    record.buffer = (record.buffer + data).slice(-TERMINAL_BUFFER);
    this.emit("terminal.output", { terminalId: record.id, data });
  }

  /** @param {TerminalRecord} record */
  _snapshot(record) {
    return { terminalId: record.id, shell: path.basename(record.shell), buffer: record.buffer, exitCode: record.exitCode };
  }
}

/**
 * Probe whether a TCP port is accepting connections on `host`.
 *
 * @param {number} port
 * @param {string} host
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
function probeLocalPort(port, host, timeoutMs = 220) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    /** @param {boolean} ok */
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

/**
 * Scan common localhost dev-server ports and return those currently listening.
 * Both address families count: Vite, for one, listens only on ::1 on Windows.
 *
 * @param {number[]} [extraPorts]
 * @returns {Promise<{ servers: Array<{ port: number, url: string }> }>}
 */
export async function detectLocalhostServers(extraPorts = []) {
  /** @type {Set<number>} */
  const portSet = new Set(DEFAULT_LOCALHOST_PORTS);
  for (const p of extraPorts) {
    if (Number.isInteger(p) && p >= 1024 && p <= 65535) portSet.add(p);
  }
  const ports = [...portSet].sort((a, b) => a - b);
  const results = await Promise.all(
    ports.map(async (port) => {
      const [v4, v6] = await Promise.all([probeLocalPort(port, "127.0.0.1"), probeLocalPort(port, "::1")]);
      return { port, listening: v4 || v6 };
    })
  );
  return {
    servers: results
      .filter((r) => r.listening)
      .map((r) => ({ port: r.port, url: `http://localhost:${r.port}` })),
  };
}

/**
 * @typedef {{
 *   id: string,
 *   text: string,
 *   done: boolean,
 *   source?: "user" | "lead" | "file",
 * }} PlanItem
 */

/**
 * What a chat's plan keeps besides its items. `dismissed` holds tasks the user
 * removed, so a lead's old checklist can't bring them back, and `seen` the
 * state each task last had in its source, so a later change there is news.
 *
 * @typedef {{ items: PlanItem[], dismissed: string[], seen: Record<string, boolean> }} SavedPlan
 */

/** @param {string} text */
const planKey = (text) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** @param {string} text */
const planItemId = (text) => `plan-${createHash("sha1").update(planKey(text)).digest("hex").slice(0, 16)}`;

/**
 * Path to the persisted plan file for `(workspace, chatId)`.
 *
 * @param {string} workspace
 * @param {string | null | undefined} chatId
 */
function planFilePath(workspace, chatId) {
  const safeChat = String(chatId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(getSessionDir(workspace), `${safeChat}.plan.json`);
}

/**
 * Extract markdown checklist items (`- [ ] ...` or `- [x] ...`) from text.
 * Code blocks are skipped: a checklist there is an example, not a task list.
 *
 * @param {string} text
 * @param {"lead" | "file"} source
 * @returns {PlanItem[]}
 */
export function extractChecklistItems(text, source = "lead") {
  /** @type {PlanItem[]} */
  const items = [];
  let fenced = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(line);
    if (!match) continue;
    const label = match[2].trim().slice(0, MAX_PLAN_TEXT);
    if (!label) continue;
    items.push({ id: planItemId(label), text: label, done: match[1].toLowerCase() === "x", source });
  }
  return items;
}

/**
 * @param {string} file
 * @returns {SavedPlan}
 */
function readSavedPlan(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      items: (Array.isArray(parsed?.items) ? parsed.items : []).filter(
        (/** @type {any} */ it) => it && typeof it.id === "string" && typeof it.text === "string" && typeof it.done === "boolean"
      ),
      dismissed: Array.isArray(parsed?.dismissed) ? parsed.dismissed.filter((/** @type {unknown} */ d) => typeof d === "string") : [],
      seen: parsed?.seen && typeof parsed.seen === "object" ? parsed.seen : {},
    };
  } catch {
    return { items: [], dismissed: [], seen: {} };
  }
}

/**
 * The checklist this chat's source holds now, one entry per task: the lead's
 * answers, oldest first so a task keeps its place and takes its newest state,
 * else a workspace `PLAN.md` / `TODO.md`.
 *
 * @param {string} workspace
 * @param {string | null | undefined} chatId
 * @returns {Map<string, PlanItem>}
 */
function sourceChecklist(workspace, chatId) {
  /** @type {Map<string, PlanItem>} */
  const latest = new Map();
  try {
    for (const turn of loadTurnLog(workspace, chatId || null)) {
      if (typeof turn?.responseSummary !== "string") continue;
      for (const item of extractChecklistItems(turn.responseSummary, "lead")) latest.set(planKey(item.text), item);
    }
  } catch {
    /* no log yet */
  }
  if (latest.size > 0) return latest;

  for (const candidate of ["PLAN.md", "TODO.md"]) {
    try {
      const res = readWorkspaceFile(workspace, candidate, { maxBytes: 64 * 1024 });
      if (res.binary) continue;
      for (const item of extractChecklistItems(res.content, "file")) latest.set(planKey(item.text), item);
      if (latest.size > 0) break;
    } catch {
      /* no such file */
    }
  }
  return latest;
}

/**
 * The plan for `(workspace, chatId)`: the saved items, plus whatever the source
 * added since. A task the user removed stays removed. A saved task follows its
 * source only when that source changed, so ticking a box by hand survives a
 * lead that keeps repeating the old state, and the lead finishing a task shows.
 *
 * @param {string} workspace
 * @param {string | null | undefined} [chatId]
 * @returns {{ items: PlanItem[] }}
 */
export function getWorkspacePlan(workspace, chatId) {
  const saved = readSavedPlan(planFilePath(workspace, chatId));
  const dismissed = new Set(saved.dismissed);
  const items = saved.items.map((item) => ({ ...item }));
  const byKey = new Map(items.map((item) => [planKey(item.text), item]));

  for (const [key, item] of sourceChecklist(workspace, chatId)) {
    if (dismissed.has(key)) continue;
    const existing = byKey.get(key);
    if (!existing) {
      items.push(item);
      byKey.set(key, item);
    } else if (Object.hasOwn(saved.seen, key) && saved.seen[key] !== item.done) {
      existing.done = item.done;
    }
  }

  return { items: items.slice(0, MAX_PLAN_ITEMS) };
}

/**
 * Save the plan's items for `(workspace, chatId)`.
 *
 * @param {string} workspace
 * @param {string | null | undefined} chatId
 * @param {PlanItem[]} items
 * @returns {{ items: PlanItem[] }}
 */
export function updateWorkspacePlan(workspace, chatId, items) {
  const file = planFilePath(workspace, chatId);
  const clean = (Array.isArray(items) ? items : [])
    .slice(0, MAX_PLAN_ITEMS)
    .map((it, idx) => ({
      id: String(it.id || `plan-${idx + 1}`),
      text: String(it.text || "").trim().slice(0, MAX_PLAN_TEXT),
      done: Boolean(it.done),
      source: it.source || "user",
    }))
    .filter((it) => it.text.length > 0);

  const checklist = sourceChecklist(workspace, chatId);
  const kept = new Set(clean.map((it) => planKey(it.text)));
  const dismissed = new Set(readSavedPlan(file).dismissed);
  for (const key of checklist.keys()) if (!kept.has(key)) dismissed.add(key);
  for (const key of kept) dismissed.delete(key);
  const seen = Object.fromEntries([...checklist].map(([key, item]) => [key, item.done]));

  atomicWriteJson(file, { updatedAt: Date.now(), items: clean, dismissed: [...dismissed], seen });
  return { items: clean };
}
