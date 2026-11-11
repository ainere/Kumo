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
 * compare.js — Two models take the same brief, side by side.
 *
 * Each runs in a git worktree of its own, set up from a snapshot of the project
 * as it stands, so uncommitted work is included and the project itself isn't
 * touched. Nothing lands until the user keeps one side.
 *
 * Each side goes through a bridge of its own, so it runs by the same rules as
 * any worker call. The session's safety mode holds: under a gated mode the
 * worker proposes a diff without writing, and the bridge applies it to the
 * worktree, which is a throwaway place to apply it. The human decision is
 * keeping a side, so no bridge here asks for one.
 *
 * A worktree isn't a sandbox: its `.git` points into the real repository. An
 * autonomous worker can reach that, as it can from any autonomous turn.
 *
 * Ignored files aren't in a worktree, so a worker won't find `node_modules`.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getSessionDir } from "../data/sessions.js";
import { connectBridge } from "../providers/api/api-lead.js";
import { bridgeEnvFrom } from "../utils/process.js";
import { countChanges, snapshotWorkspace } from "./checkpoints.js";
import { localFilters, realpathSafe, runGit } from "./workbench.js";

/** The role a compared brief goes to. The model is the point of the comparison, so each side sets its own. */
const COMPARE_TOOL = "worker_implement";
const WORKTREE_TIMEOUT_MS = 60_000;
/** A worktree still here after this long was left by an app that didn't get to clean up. */
const STALE_WORKTREE_MS = 24 * 3600 * 1000;
/** How much of a worker's closing words each side keeps to show. */
const MAX_DETAIL_CHARS = 4000;

/**
 * @typedef {{ provider: string, model: string, effort?: string }} CompareTarget
 * @typedef {{
 *   provider: string,
 *   model: string,
 *   effort: string | null,
 *   status: "running" | "done" | "failed" | "stopped",
 *   detail: string,
 *   tree: string | null,
 *   changed: number | null,
 *   elapsedMs: number | null,
 * }} CompareSide
 * @typedef {{
 *   id: string,
 *   brief: string,
 *   at: number,
 *   base: string,
 *   status: "running" | "ready" | "closed",
 *   sides: CompareSide[],
 * }} CompareState
 */

/**
 * Set up a worktree holding exactly `tree`. It starts empty and is filled by
 * `read-tree`, because a plain `worktree add` fires the repository's
 * post-checkout hook and runs its filters on every file.
 *
 * @param {string} workspace
 * @param {string} tree
 * @param {string} dir
 * @returns {Promise<string>} where the workspace is inside it: the same subfolder, for a workspace that is one
 */
export async function makeWorktree(workspace, tree, dir) {
  const rootReal = realpathSafe(workspace);
  const { env } = await localFilters(rootReal);
  const opts = { timeoutMs: WORKTREE_TIMEOUT_MS, env };
  const prefix = (await runGit(rootReal, ["rev-parse", "--show-prefix"])).stdout.trim();
  const added = await runGit(rootReal, ["worktree", "add", "--detach", "--no-checkout", dir, "HEAD"], opts);
  if (!added.ok) throw new Error("Comparing needs a repository with at least one commit.");
  const filled = await runGit(dir, ["read-tree", "--reset", "-u", tree], opts);
  if (!filled.ok) {
    await removeWorktree(workspace, dir);
    throw new Error("Couldn't set up a copy of the project.");
  }
  return path.join(dir, prefix);
}

/** Whether two paths name the same place, ignoring the case Windows ignores. */
const samePath = (/** @type {string} */ a, /** @type {string} */ b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Git's administrative folder for the worktree at `dir`, or null when it cannot
 * be vouched for. The worktree's `.git` file says where it is
 * (`gitdir: <common-dir>/worktrees/<id>`), but that file sits in a folder a
 * worker writes to, so it is believed only when the folder it names is a real
 * directory (not a link) directly under this repository's `worktrees` folder,
 * and points back at this very `.git` file.
 *
 * @param {string} workspace
 * @param {string} dir
 * @returns {Promise<string | null>}
 */
async function worktreeAdminDir(workspace, dir) {
  try {
    const dotGit = path.join(realpathSafe(dir), ".git");
    if (!(await fs.promises.lstat(dotGit)).isFile()) return null;
    const named = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, "utf-8"))?.[1];
    if (!named) return null;

    const root = realpathSafe(workspace);
    const common = (await runGit(root, ["rev-parse", "--git-common-dir"])).stdout.trim();
    if (!common) return null;
    const worktrees = realpathSafe(path.join(path.resolve(root, common), "worktrees"));

    const admin = path.resolve(realpathSafe(dir), named);
    const adminStat = await fs.promises.lstat(admin);
    if (adminStat.isSymbolicLink() || !adminStat.isDirectory()) return null;
    const real = realpathSafe(admin);
    if (!samePath(path.dirname(real), worktrees) || !samePath(real, path.join(worktrees, path.basename(admin)))) return null;

    const backPointer = (await fs.promises.readFile(path.join(admin, "gitdir"), "utf-8")).trim();
    const pointed = path.resolve(admin, backPointer);
    return samePath(path.join(realpathSafe(path.dirname(pointed)), path.basename(pointed)), dotGit) ? admin : null;
  } catch {
    // Missing or unreadable: git's records are not Kumo's to guess at.
    return null;
  }
}

/**
 * Remove a worktree and git's record of it. Node deletes it, not git: a worker
 * may well link the real `node_modules` in, and to git a junction is a folder to
 * empty. Only this worktree's own administrative entry goes with it, and only
 * when it checks out (see {@link worktreeAdminDir}); `git worktree prune` is
 * never run, because it also forgets the user's own worktrees that happen to be
 * missing at that moment. Best effort: a killed worker can hold a file for a
 * moment, and what stays behind is cleared next time.
 *
 * @param {string} workspace
 * @param {string} dir
 */
export async function removeWorktree(workspace, dir) {
  const admin = await worktreeAdminDir(workspace, dir);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  if (admin) await fs.promises.rm(admin, { recursive: true, force: true }).catch(() => {});
}

/**
 * Clear what an app that didn't get to clean up left in `root`.
 *
 * @param {string} workspace
 * @param {string} root
 */
export async function removeStaleWorktrees(workspace, root) {
  const names = await fs.promises.readdir(root).catch(() => /** @type {string[]} */ ([]));
  const cutoff = Date.now() - STALE_WORKTREE_MS;
  await Promise.all(
    names.map(async (name) => {
      const dir = path.join(root, name);
      const stat = await fs.promises.stat(dir).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await removeWorktree(workspace, dir);
    })
  );
}

/**
 * The preview waiting to be confirmed, if the bridge says one is. It says so
 * last, after the worker's own output, which could quote these words.
 *
 * @param {string} text
 * @returns {string | null}
 */
function previewIdIn(text) {
  const status = text.lastIndexOf("[STATUS: PENDING_CONFIRMATION]");
  if (status === -1) return null;
  return /Preview ID: "([^"]+)"/.exec(text.slice(status))?.[1] ?? null;
}

/**
 * Run one comparison. The session owns it and asks it for its state.
 */
export class CompareRun {
  /**
   * @param {{
   *   workspace: string,
   *   brief: string,
   *   base: string,
   *   root: string,
   *   targets: CompareTarget[],
   *   safetyMode: string,
   *   timeoutMs: number,
   *   onChange: () => void,
   *   connect?: typeof connectBridge,
   * }} opts
   */
  constructor(opts) {
    this.options = opts;
    this.connect = opts.connect || connectBridge;
    this.controller = new AbortController();
    /** @type {string[]} */
    this.dirs = [];
    /** @type {string[]} */
    this.workdirs = [];
    /** @type {CompareState} */
    this.state = {
      id: randomUUID(),
      brief: opts.brief,
      at: Date.now(),
      base: opts.base,
      status: "running",
      sides: opts.targets.map((t) => ({
        provider: t.provider,
        model: t.model,
        effort: t.effort || null,
        status: "running",
        detail: "",
        tree: null,
        changed: null,
        elapsedMs: null,
      })),
    };
    /** Settles when both sides have. */
    this.done = Promise.all(this.state.sides.map((side, i) => this._runSide(side, i))).then(() => {
      if (this.state.status === "running") this.state.status = "ready";
      opts.onChange();
    });
  }

  /**
   * @param {CompareSide} side
   * @param {number} index
   */
  async _runSide(side, index) {
    const { workspace, brief, base, root, safetyMode, timeoutMs } = this.options;
    const startedAt = Date.now();
    const { signal } = this.controller;
    /** @type {import("../providers/api/api-lead.js").BridgeConnection | null} */
    let connection = null;
    try {
      // Short: every path inside the worktree has to fit under Windows' limit too.
      const dir = path.join(root, `${this.state.id.slice(0, 8)}-${index}`);
      this.dirs.push(dir);
      await fs.promises.mkdir(root, { recursive: true });
      const workdir = await makeWorktree(workspace, base, dir);
      this.workdirs.push(workdir);
      signal.throwIfAborted();
      connection = await this.connect({
        workspace: workdir,
        env: { ...bridgeEnvFrom(process.env, [side.provider]), KUMO_SAFETY_MODE: safetyMode },
        signal,
      });
      const args = {
        task: brief,
        provider: side.provider,
        model: side.model,
        ...(side.effort ? { effort: side.effort } : {}),
      };
      const call = { signal, timeoutMs };
      let result = await connection.callTool(COMPARE_TOOL, args, call);
      const previewId = result.isError ? null : previewIdIn(result.text);
      if (previewId) result = await connection.callTool(COMPARE_TOOL, { ...args, confirm: true, previewId }, call);
      if (result.isError) throw new Error(result.text);
      side.tree = await snapshotWorkspace(workdir);
      side.changed = side.tree ? await countChanges(workdir, base, side.tree) : 0;
      side.detail = result.text.slice(0, MAX_DETAIL_CHARS);
      side.status = "done";
    } catch (err) {
      side.status = signal.aborted ? "stopped" : "failed";
      side.detail = (err instanceof Error ? err.message : String(err)).slice(0, MAX_DETAIL_CHARS);
    } finally {
      side.elapsedMs = Date.now() - startedAt;
      await connection?.close().catch(() => {});
      this.options.onChange();
    }
  }

  /** Stop what is running and remove the worktrees. Every side's result stays in git until the session lets it go. */
  async close() {
    this.state.status = "closed";
    this.controller.abort();
    await this.done.catch(() => {});
    await Promise.all(this.dirs.map((dir) => removeWorktree(this.options.workspace, dir)));
    // Each bridge kept its live logs under its worktree's name, which nothing will open again.
    await Promise.all(
      this.workdirs.map((dir) => fs.promises.rm(getSessionDir(dir), { recursive: true, force: true }).catch(() => {}))
    );
  }
}

