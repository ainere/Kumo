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
 * git.js — the one place that decides how Kumo runs git inside a project.
 *
 * A project's own `.git/config` can name commands for git to run (a
 * `core.fsmonitor`, a filter driver), and a folder can hold a planted
 * `git.exe`. The engine ({@link ../core/workbench.js runGit}) and the bridge
 * both run git in untrusted folders, so they share these defences.
 */

import { spawnSync } from "node:child_process";
import { resolveBinary } from "./process.js";

/**
 * Every git call here runs by itself as soon as a project opens, and a folder's
 * own `.git/config` can name commands for git to run. A downloaded project
 * mustn't get code execution just by being looked at, so these turn off what
 * would run one, and `autoRefreshIndex` keeps a background diff from writing
 * the index under a worker's `git add`. Hooks fire from plumbing too:
 * `update-ref` runs `reference-transaction`. Settings of a submodule's own are
 * out of reach of all of this, so git never goes into one. See also
 * {@link filterOverrides}.
 */
export const GIT_SAFE_CONFIG = [
  "-c",
  "core.quotePath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=NUL",
  "-c",
  "diff.autoRefreshIndex=false",
  "-c",
  "submodule.recurse=false",
];

/** Without this, a blob missing from a "partial clone" is fetched, running whatever `core.sshCommand` says. */
export const GIT_SAFE_ENV = { GIT_NO_LAZY_FETCH: "1" };

/** The arguments that list every configured filter driver together with the scope that defined it. */
export const LIST_FILTERS_ARGS = ["config", "--show-scope", "--name-only", "--get-regexp", "^filter\\."];

/**
 * git by absolute path when it is installed (a bare name would let a `git.exe`
 * in the project win on some setups), else the bare name.
 *
 * @returns {string}
 */
export function gitBinary() {
  return resolveBinary("git");
}

/**
 * `git diff` runs clean filters on changed files, and a repository can define
 * its own, so filters from inside the folder are switched off for a call. The
 * user's own (global and system, like Git LFS) stay. The cost: a repository
 * whose filter lives only in its `.git/config`, as git-crypt's does, shows the
 * filtered files as changed.
 *
 * The overrides go through the environment, not `-c`, which splits at the first
 * `=`: a driver named `x=y` would slip past it. Any git call that can write an
 * index needs them, because rewriting one compares files by content.
 *
 * @param {string} listing - stdout of git run with {@link LIST_FILTERS_ARGS}
 * @returns {{ env: Record<string, string>, drivers: Set<string> }}
 */
export function filterOverrides(listing) {
  /** @type {Set<string>} */
  const drivers = new Set();
  for (const line of listing.split(/\r?\n/)) {
    const [scope, key] = line.split("\t");
    if (!key || scope === "global" || scope === "system") continue;
    // The name may be empty: `[filter ""]` is a driver like any other.
    const driver = /^filter\.(.*)\.[^.]+$/.exec(key)?.[1];
    if (driver !== undefined) drivers.add(driver);
  }
  const settings = [...drivers].flatMap((driver) => [
    [`filter.${driver}.clean`, ""],
    [`filter.${driver}.smudge`, ""],
    [`filter.${driver}.process`, ""],
    [`filter.${driver}.required`, "false"],
  ]);
  /** @type {Record<string, string>} */
  const env = settings.length > 0 ? { GIT_CONFIG_COUNT: String(settings.length) } : {};
  settings.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { env, drivers };
}

/**
 * A synchronous git runner for one folder, for one top-level operation.
 *
 * The folder's local filter drivers are read once, when the runner is made, and
 * switched off for every call it makes. Make a new runner per operation and do
 * not keep one: a worker can edit `.git/config` between operations.
 *
 * @param {string} cwd
 * @returns {(args: string[], opts?: { cwd?: string, env?: Record<string, string>, timeout?: number, maxBuffer?: number }) => import("node:child_process").SpawnSyncReturns<string>}
 */
export function createGitRunner(cwd) {
  const bin = gitBinary();
  const listing = spawnSync(bin, [...GIT_SAFE_CONFIG, ...LIST_FILTERS_ARGS], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    timeout: 10000,
    env: { ...process.env, ...GIT_SAFE_ENV },
  });
  const { env: filterEnv } = filterOverrides(typeof listing.stdout === "string" ? listing.stdout : "");

  return (args, { cwd: runCwd = cwd, env, timeout, maxBuffer = 64 * 1024 * 1024 } = {}) =>
    spawnSync(bin, [...GIT_SAFE_CONFIG, ...args], {
      cwd: runCwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout,
      maxBuffer,
      env: { ...process.env, ...GIT_SAFE_ENV, ...filterEnv, ...env },
    });
}
