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
 * checkpoints.js — What a project looked like around each turn.
 *
 * A snapshot is a git tree written through a temporary index, so the user's
 * index, HEAD and branches stay as they are. A ref under `refs/kumo/cp/` keeps
 * each tree from being collected. The ref names a tree, not a commit: history
 * views walk commits, so these never appear in `git log --all` or a graph tool,
 * and writing one needs no git identity.
 *
 * The rule for changing files: a rewind has to be undoable, and it can only
 * undo what a snapshot holds. So a path is written only if what's there now is
 * in the snapshot it starts from, or nothing is there. Anything else (an ignored
 * file, a folder, a file past the size limit, a link) stays as it is and is
 * reported. Nothing is read, written or deleted through a link: to git a Windows
 * junction is a plain folder, and it will empty the folder at the other end.
 *
 * Not covered: files under a filter the repository defines for itself, like
 * git-crypt's. Filters can't run here, so a snapshot of one would hold its
 * plaintext in `.git` and a restore would write its stored bytes over the file.
 * They stay out of snapshots and rewinds. Folders outside a repository have no
 * checkpoints.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  diffTrees,
  isInsideRoot,
  linkedFolders,
  listUntracked,
  localFilters,
  realpathSafe,
  runGit,
  splitNul,
} from "./workbench.js";

/** Short on purpose: loose refs are files under `.git`, and every path has to fit under Windows' limit. */
const REF_ROOT = "refs/kumo/cp";
/** Longer than a diff gets: this waits on hashing every changed file. */
const SNAPSHOT_TIMEOUT_MS = 30_000;
/** A new file past this is left out of snapshots: a stray dump shouldn't land in the project's `.git`. */
const MAX_SNAPSHOT_FILE_BYTES = 32 * 1024 * 1024;
/** Turns kept per chat. The oldest go first, and git collects what only they held. */
export const MAX_CHECKPOINTS = 100;

const TREE_ID = /^[0-9a-f]{40,64}$/;
const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";

/**
 * @typedef {{
 *   id: string,
 *   kind: "turn" | "rewind",
 *   label: string,
 *   at: number,
 *   start: string,
 *   end: string | null,
 *   changed: number | null,
 * }} Checkpoint
 *   `start` and `end` are trees. A turn's `end` stays null until it finishes, so
 *   one cut short by a crash can still be rewound. A rewind is a checkpoint too:
 *   its `start` is what it replaced, so going back to it undoes the rewind.
 * @typedef {{ write: string[], remove: string[], added: Set<string> }} TreeChanges
 *   `added` are the written paths the starting tree doesn't have.
 * @typedef {{ write: string[], remove: string[], blocked: string[] }} ChangePlan
 *   `blocked` are the paths that can't be written safely, so they won't be.
 */

/** @param {string} tree */
function assertTree(tree) {
  if (!TREE_ID.test(tree)) throw new Error("Not a checkpoint.");
}

/** @param {string} id */
const shortId = (id) => createHash("sha256").update(id).digest("hex").slice(0, 12);

/** @param {string} chatId */
const chatPrefix = (chatId) => `${REF_ROOT}/${shortId(chatId)}/`;

/**
 * @param {string} chatId
 * @param {string} id
 * @param {"start" | "end"} side
 */
const refName = (chatId, id, side) => `${chatPrefix(chatId)}${shortId(id)}/${side}`;

/**
 * Hand `fn` a throwaway copy of the repository's index. A copy lets git skip
 * every file whose size and time haven't moved, and a real index held by a
 * running `git add` is no obstacle to it.
 *
 * Only "there is none yet" can be let go: going on without an index that exists
 * would give a tree with no tracked files, and a rewind would delete them.
 *
 * @template T
 * @param {string} rootReal
 * @param {(index: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withIndexCopy(rootReal, fn) {
  const found = await runGit(rootReal, ["rev-parse", "--git-path", "index"]);
  const indexPath = found.stdout.trim();
  if (!found.ok || !indexPath) throw new Error("git couldn't find the index");
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "kumo-checkpoint-"));
  try {
    const index = path.join(tmp, "index");
    await fs.promises.copyFile(path.resolve(rootReal, indexPath), index).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
    return await fn(index);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * New files a snapshot can take. Git lists a nested repository as a folder
 * ending in a slash; adding one fails if it has no commits, and it isn't this
 * project's to snapshot anyway. A list that can't be read whole fails the
 * snapshot: a tree missing new files would have a rewind delete them.
 *
 * @param {string} rootReal
 * @returns {Promise<string[]>}
 */
async function snapshotCandidates(rootReal) {
  const listed = await listUntracked(rootReal, { timeoutMs: SNAPSHOT_TIMEOUT_MS });
  if (listed === null) throw new Error("git couldn't list the new files");
  const sized = await Promise.all(
    listed
      .filter((rel) => !rel.endsWith("/"))
      .map(async (rel) => {
        const stat = await fs.promises.lstat(path.join(rootReal, rel)).catch(() => null);
        return stat !== null && stat.size <= MAX_SNAPSHOT_FILE_BYTES ? rel : null;
      })
  );
  return sized.filter((rel) => rel !== null);
}

/**
 * Sort tracked paths git says have changed. Adding one that's now a folder or
 * sits behind a link would pull in whatever is inside, from anywhere on the
 * disk, so those count as gone, like one that isn't there at all. A submodule
 * and a true symlink are entries of their own and can be added as they are.
 *
 * @param {string} rootReal
 * @param {string} listing the output of `ls-files --stage -z`
 * @returns {Promise<{ add: string[], gone: string[] }>}
 */
async function sortTracked(rootReal, listing) {
  const throughLink = linkedFolders(rootReal);
  /** @type {Map<string, string>} */
  const entries = new Map();
  for (const line of splitNul(listing)) entries.set(line.slice(line.indexOf("\t") + 1), line.slice(0, 6));
  /** @type {string[]} */
  const add = [];
  /** @type {string[]} */
  const gone = [];
  for (const [rel, mode] of entries) {
    const dir = path.posix.dirname(rel);
    const linked = dir !== "." && (await throughLink(dir));
    const stat = linked ? null : await fs.promises.lstat(path.join(rootReal, rel)).catch(() => null);
    const replaced = mode !== GITLINK_MODE && (stat?.isDirectory() || (stat?.isSymbolicLink() && mode !== SYMLINK_MODE));
    (!stat || replaced ? gone : add).push(rel);
  }
  return { add, gone };
}

/**
 * Drop paths under a filter the repository defines for itself (see the top of
 * this file).
 *
 * @param {(args: string[], input?: string) => ReturnType<typeof runGit>} git
 * @param {string[]} paths
 * @param {Set<string>} drivers
 * @returns {Promise<string[]>}
 */
async function withoutLocalFilters(git, paths, drivers) {
  if (drivers.size === 0 || paths.length === 0) return paths;
  const res = await git(["check-attr", "-z", "--stdin", "filter"], paths.join("\0"));
  if (!res.ok) throw new Error("git couldn't read the file attributes");
  const fields = res.stdout.split("\0");
  /** @type {Set<string>} */
  const filtered = new Set();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (drivers.has(fields[i + 2])) filtered.add(fields[i]);
  }
  return paths.filter((rel) => !filtered.has(rel));
}

/**
 * Write the workspace's current state as a tree.
 *
 * @param {string} rootReal
 * @returns {Promise<string>}
 */
function writeSnapshot(rootReal) {
  return withIndexCopy(rootReal, async (index) => {
    const filters = await localFilters(rootReal);
    /**
     * Every step here needs the filters off, `write-tree` included: rewriting an
     * index makes git compare files it can't trust by time, which runs them.
     * A strict safecrlf would refuse a file with mixed line endings, and with it the whole snapshot.
     *
     * @param {string[]} args
     * @param {string} [input]
     */
    const git = (args, input) =>
      runGit(rootReal, ["-c", "core.safecrlf=false", ...args], {
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
        env: { ...filters.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" },
        input,
      });
    const changed = await git(["ls-files", "-z", "--stage", "--modified", "--deleted"]);
    if (!changed.ok || changed.truncated) throw new Error("git couldn't read the changed files");
    const { add, gone } = await sortTracked(rootReal, changed.stdout);
    const paths = await withoutLocalFilters(git, [...new Set([...add, ...(await snapshotCandidates(rootReal))])], filters.drivers);
    if (gone.length > 0) {
      const removed = await git(["update-index", "--force-remove", "-z", "--stdin"], gone.join("\0"));
      if (!removed.ok) throw new Error("git couldn't read the changed files");
    }
    if (paths.length > 0) {
      // Forced: the list is settled by now, and a tracked file can sit under a name git ignores.
      const added = await git(["add", "-A", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], paths.join("\0"));
      if (!added.ok) throw new Error("git couldn't read the changed files");
    }
    const tree = await git(["write-tree"]);
    const id = tree.stdout.trim();
    if (!tree.ok || !TREE_ID.test(id)) throw new Error("git couldn't write the snapshot");
    return id;
  });
}

/**
 * The workspace's current state as a tree, or null outside a repository.
 * Throws when git can't take one.
 *
 * @param {string} workspace
 * @returns {Promise<string | null>}
 */
export async function snapshotWorkspace(workspace) {
  const rootReal = realpathSafe(workspace);
  const found = await runGit(rootReal, ["rev-parse", "--is-inside-work-tree"]);
  if (!found.ok || found.stdout.trim() !== "true") return null;
  try {
    return await writeSnapshot(rootReal);
  } catch {
    // A file listed a moment ago can be gone by the time git reads it (a dev server's temp file), so once more on a fresh list.
    return writeSnapshot(rootReal);
  }
}

/**
 * Keep a checkpoint's trees alive. Throws if they can't be: a rewind must not
 * go ahead on an undo that git is free to collect.
 *
 * @param {string} workspace
 * @param {string} chatId
 * @param {Checkpoint} entry
 */
export async function keepCheckpoint(workspace, chatId, entry) {
  const rootReal = realpathSafe(workspace);
  const lines = [`update ${refName(chatId, entry.id, "start")} ${entry.start}`];
  if (entry.end) lines.push(`update ${refName(chatId, entry.id, "end")} ${entry.end}`);
  const res = await runGit(rootReal, ["update-ref", "--stdin"], { input: `${lines.join("\n")}\n` });
  if (!res.ok) throw new Error("git couldn't keep the snapshot");
}

/**
 * Drop refs under a prefix, so git can collect their trees. Best effort: a
 * folder that has since moved or lost its repository has nothing to drop.
 *
 * @param {string} rootReal
 * @param {string} prefix
 */
async function dropRefs(rootReal, prefix) {
  const res = await runGit(rootReal, ["for-each-ref", "--format=%(refname)", prefix]);
  const refs = res.stdout.split(/\r?\n/).filter(Boolean);
  if (!res.ok || refs.length === 0) return;
  await runGit(rootReal, ["update-ref", "--stdin"], { input: refs.map((ref) => `delete ${ref}\n`).join("") });
}

/**
 * @param {string} workspace
 * @param {string} chatId
 * @param {string} id
 */
export function dropCheckpoint(workspace, chatId, id) {
  return dropRefs(realpathSafe(workspace), `${chatPrefix(chatId)}${shortId(id)}/`);
}

/**
 * Drop one chat's checkpoints.
 *
 * @param {string} workspace
 * @param {string} chatId
 */
export function dropCheckpoints(workspace, chatId) {
  return dropRefs(realpathSafe(workspace), chatPrefix(chatId));
}

/**
 * Paths that differ between two trees, by what getting from `from` to `to`
 * would do to them. Submodules aren't among them: a rewind can't move one.
 *
 * @param {string} rootReal
 * @param {string} from
 * @param {string} to
 * @returns {Promise<TreeChanges>}
 */
async function changedPaths(rootReal, from, to) {
  assertTree(from);
  assertTree(to);
  const res = await runGit(rootReal, [
    "diff",
    "--name-status",
    "-z",
    "--no-renames",
    "--relative",
    "--no-ext-diff",
    "--ignore-submodules=all",
    from,
    to,
  ]);
  if (!res.ok || res.truncated) throw new Error("This checkpoint is no longer in the repository.");
  /** @type {TreeChanges} */
  const changes = { write: [], remove: [], added: new Set() };
  const fields = splitNul(res.stdout);
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, rel] = [fields[i], fields[i + 1]];
    if (status === "D") {
      changes.remove.push(rel);
    } else {
      changes.write.push(rel);
      if (status === "A") changes.added.add(rel);
    }
  }
  return changes;
}

/**
 * How many files differ between two trees.
 *
 * @param {string} workspace
 * @param {string} from
 * @param {string} to
 * @returns {Promise<number>}
 */
export async function countChanges(workspace, from, to) {
  const { write, remove } = await changedPaths(realpathSafe(workspace), from, to);
  return write.length + remove.length;
}

/**
 * What going from one tree to another changes, as a diff.
 *
 * @param {string} workspace
 * @param {string} from
 * @param {string} to
 */
export async function diffCheckpoints(workspace, from, to) {
  assertTree(from);
  assertTree(to);
  const rootReal = realpathSafe(workspace);
  // A diff that can't find its trees reads as empty; this one should say so.
  const present = await Promise.all([from, to].map((tree) => runGit(rootReal, ["cat-file", "-e", `${tree}^{tree}`])));
  if (!present.every((res) => res.ok)) throw new Error("This checkpoint is no longer in the repository.");
  return diffTrees(rootReal, from, to);
}

/**
 * Whether a folder holds nothing but paths about to be removed.
 *
 * @param {string} rootReal
 * @param {string} rel
 * @param {Set<string>} removing
 * @returns {Promise<boolean>}
 */
async function emptyOnceRemoved(rootReal, rel, removing) {
  const entries = await fs.promises.readdir(path.join(rootReal, rel), { withFileTypes: true }).catch(() => null);
  if (!entries) return false;
  for (const entry of entries) {
    const child = `${rel}/${entry.name}`;
    if (removing.has(child)) continue;
    // A junction isn't a directory here, so it's never walked.
    if (!entry.isDirectory() || !(await emptyOnceRemoved(rootReal, child, removing))) return false;
  }
  return true;
}

/**
 * Whether a path can be written without losing anything a snapshot doesn't hold
 * or reaching out of the workspace.
 *
 * @param {string} rootReal
 * @param {string} rel
 * @param {boolean} added the starting tree doesn't have this path
 * @param {Set<string>} removing
 * @param {(dir: string) => Promise<boolean>} throughLink
 * @returns {Promise<boolean>}
 */
async function canWrite(rootReal, rel, added, removing, throughLink) {
  if (rel.split("/").some((part) => part.toLowerCase() === ".git")) return false;
  const dir = path.posix.dirname(rel);
  if (dir !== "." && (await throughLink(dir))) return false;
  // Git would replace a file that stands where the path needs a folder.
  for (let up = dir; up !== "."; up = path.posix.dirname(up)) {
    const stat = await fs.promises.lstat(path.join(rootReal, up)).catch(() => null);
    if (stat && !stat.isDirectory() && !removing.has(up)) return false;
  }
  const stat = await fs.promises.lstat(path.join(rootReal, rel)).catch(() => null);
  if (!stat) return true;
  if (stat.isDirectory()) return emptyOnceRemoved(rootReal, rel, removing);
  // A file or link here that the snapshot doesn't have can't come back from an undo.
  return !added;
}

/**
 * Decide what going through a set of changes will really do.
 *
 * @param {string} rootReal
 * @param {TreeChanges} changes
 * @returns {Promise<ChangePlan>}
 */
async function planChanges(rootReal, { write, remove, added }) {
  const removing = new Set(remove);
  const throughLink = linkedFolders(rootReal);
  /** @type {ChangePlan} */
  const plan = { write: [], remove, blocked: [] };
  for (const rel of write) {
    const safe = await canWrite(rootReal, rel, added.has(rel), removing, throughLink);
    (safe ? plan.write : plan.blocked).push(rel);
  }
  return plan;
}

/**
 * Delete a file a rewind takes away, and any folders that leaves empty.
 * Nothing is deleted through a link, and folders are left alone: a nested
 * repository shows up in a tree as one entry.
 *
 * @param {string} rootReal
 * @param {string} rel
 * @returns {Promise<boolean>} whether it's gone
 */
async function removeFile(rootReal, rel) {
  if (rel.split("/").some((part) => part.toLowerCase() === ".git")) return false;
  const full = path.join(rootReal, rel);
  const parent = realpathSafe(path.dirname(full));
  if (!isInsideRoot(rootReal, parent)) return false;
  const stat = await fs.promises.lstat(full).catch(() => null);
  if (!stat) return true;
  if (stat.isDirectory()) return false;
  const gone = await fs.promises.unlink(full).then(
    () => true,
    () => false
  );
  for (let dir = parent; gone && dir !== rootReal && isInsideRoot(rootReal, dir); dir = path.dirname(dir)) {
    const removed = await fs.promises.rmdir(dir).then(
      () => true,
      () => false
    );
    if (!removed) break;
  }
  return gone;
}

/**
 * Carry out a plan: write paths out of a tree and delete others. The index and
 * branches stay as they are, so a changed file shows as an ordinary change.
 *
 * @param {string} rootReal
 * @param {string} to
 * @param {ChangePlan} plan
 * @returns {Promise<{ restored: number, removed: number, failed: string[] }>}
 */
async function applyPlan(rootReal, to, { write, remove, blocked }) {
  const failed = [...blocked];
  let removed = 0;
  // Removals first: a folder in the target may be a file now, or the reverse.
  for (const rel of remove) {
    if (await removeFile(rootReal, rel)) removed++;
    else failed.push(rel);
  }
  if (write.length === 0) return { restored: 0, removed, failed };
  const filters = await localFilters(rootReal);
  // On a copy of the index, because a held `index.lock` would stop this after the removals have happened.
  const res = await withIndexCopy(rootReal, (index) =>
    runGit(rootReal, ["restore", `--source=${to}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      env: { ...filters.env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" },
      input: write.join("\0"),
    })
  );
  if (!res.ok) return { restored: 0, removed, failed: [...failed, ...write] };
  return { restored: write.length, removed, failed };
}

/**
 * Make the workspace match a tree, going from the state in `from`, which must
 * be a snapshot of it. Only paths that differ are touched, and paths that can't
 * safely be written stay as they are, in `failed`.
 *
 * @param {string} workspace
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{ restored: number, removed: number, failed: string[] }>}
 */
export async function restoreTree(workspace, from, to) {
  const rootReal = realpathSafe(workspace);
  return applyPlan(rootReal, to, await planChanges(rootReal, await changedPaths(rootReal, from, to)));
}

/**
 * What {@link restoreTree} would do, as a diff, and which paths it would leave.
 *
 * @param {string} workspace
 * @param {string} from
 * @param {string} to
 */
export async function previewRestore(workspace, from, to) {
  const rootReal = realpathSafe(workspace);
  const { blocked } = await planChanges(rootReal, await changedPaths(rootReal, from, to));
  const skipped = new Set(blocked);
  const { files, truncated } = await diffCheckpoints(workspace, from, to);
  return { files: files.filter((file) => !skipped.has(file.path)), truncated, blocked };
}

/**
 * Bring what `side` changed from `base` into the workspace, whose state is
 * `now`. Work done since `base` stays. If the two touched the same file, or a
 * path can't be written safely, nothing moves (`conflicts`), so nobody's half of
 * a change lands. A file locked by another program can still fail once writing
 * has begun (`failed`): by then it has landed, and only a rewind takes it back.
 *
 * @param {string} workspace
 * @param {string} base
 * @param {string} side
 * @param {string} now
 * @returns {Promise<{ restored: number, removed: number, conflicts: string[], failed: string[] }>}
 */
export async function applyChanges(workspace, base, side, now) {
  const rootReal = realpathSafe(workspace);
  const theirs = await changedPaths(rootReal, base, side);
  const mine = await changedPaths(rootReal, base, now);
  // Windows sees one file behind both spellings.
  const touched = new Set([...mine.write, ...mine.remove].map((rel) => rel.toLowerCase()));
  const conflicts = [...theirs.write, ...theirs.remove].filter((rel) => touched.has(rel.toLowerCase()));
  if (conflicts.length > 0) return { restored: 0, removed: 0, conflicts, failed: [] };
  const plan = await planChanges(rootReal, theirs);
  // All or nothing here too: a side that can only half land isn't the side that was reviewed.
  if (plan.blocked.length > 0) return { restored: 0, removed: 0, conflicts: plan.blocked, failed: [] };
  return { ...(await applyPlan(rootReal, side, plan)), conflicts: [] };
}
