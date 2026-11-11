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
 * stage-engine.mjs — Lays the engine out for the installer, in out/engine.
 *
 * The app runs the engine from plain files: its utility process imports
 * src/core at runtime, and provider CLIs start the bridge as
 * `Kumo.exe src/bridge/server.js` with ELECTRON_RUN_AS_NODE, or with a system
 * node. Neither should depend on reading an asar, so electron-builder puts
 * this folder beside it, as resources/engine, laid out like the repository:
 *
 *   package.json   the root manifest without its development fields; version.js
 *                  reads the version from it, and "type": "module" keeps src/ ESM
 *   LICENSE
 *   src/           the repository's src/, as it is
 *   node_modules/  what the root package needs at runtime, each at the path npm
 *                  installed it to, so every import resolves as it does in the
 *                  repository, plus node-pty with only its Windows prebuilds
 *
 * Usage: node scripts/stage-engine.mjs [--arch x64|arm64] [--out <folder>]
 *   --arch  node-pty's binaries to keep (default: this machine's)
 *   --out   where to stage (default: out/engine, where electron-builder.yml looks)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repo = path.resolve(appDir, "../..");
const out = path.resolve(option("--out") ?? path.join(appDir, "out", "engine"));
const arch = option("--arch") ?? process.arch;
if (arch !== "x64" && arch !== "arm64") fail(`--arch must be x64 or arm64, not ${arch}.`);

/** Licence texts are kept wherever they are. */
const LICENSE_FILE = /^(?:licen[cs]e|notice|copying)/i;
/** Never read by a running package: docs, source maps, and TypeScript, which Node won't run from node_modules. */
const UNUSED_FILE = /\.(?:md|markdown|map|[cm]?ts)$/i;

const root = readJson(path.join(repo, "package.json"));
// The folder is emptied first, so it has to be one this script made.
const above = path.relative(out, repo);
if (!above || (!above.startsWith("..") && !path.isAbsolute(above))) fail(`--out can't be the repository or a folder above it (${out}).`);
if (fs.existsSync(out) && fs.readdirSync(out).length > 0 && !isStage(out)) fail(`${out} isn't empty and isn't an earlier stage; pick another --out.`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

writeJson(path.join(out, "package.json"), {
  name: root.name,
  version: root.version,
  description: root.description,
  type: root.type,
  private: true,
  license: root.license,
  engines: root.engines,
  dependencies: root.dependencies,
});
fs.copyFileSync(path.join(repo, "LICENSE"), path.join(out, "LICENSE"));
fs.cpSync(path.join(repo, "src"), path.join(out, "src"), { recursive: true });

const packages = dependencyClosure(repo, root);
for (const [from, to] of packages) copyPackage(from, path.join(out, to), keepInPackage);
stageNodePty();

const { files, bytes } = measure(out);
console.log(`stage-engine: ${packages.size + 1} packages, ${files} files, ${(bytes / 1048576).toFixed(1)} MB in ${path.relative(appDir, out)}`);

/**
 * Every package `manifest` needs at runtime, found the way Node finds them,
 * as a map from where it is to where it goes under out/engine.
 *
 * @param {string} dir the folder `manifest` belongs to
 * @param {Record<string, any>} manifest
 */
function dependencyClosure(dir, manifest) {
  /** @type {Map<string, string>} */
  const found = new Map();
  /** @type {{ name: string, from: string, optional: boolean }[]} */
  const queue = [];
  const enqueue = (/** @type {string} */ from, /** @type {Record<string, any>} */ pkg) => {
    for (const name of Object.keys(pkg.dependencies ?? {})) queue.push({ name, from, optional: false });
    for (const name of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name, from, optional: true });
    // A peer is the requiring package's to provide; take it when it's installed.
    for (const name of Object.keys(pkg.peerDependencies ?? {})) queue.push({ name, from, optional: true });
  };
  enqueue(dir, manifest);
  while (queue.length > 0) {
    const { name, from, optional } = /** @type {{ name: string, from: string, optional: boolean }} */ (queue.shift());
    const location = resolvePackage(name, from);
    if (!location) {
      if (optional) continue;
      fail(`${name} (needed by ${path.relative(repo, from) || "the root package"}) isn't installed. Run npm install first.`);
    }
    if (found.has(location)) continue;
    found.set(location, destinationOf(location));
    enqueue(location, readJson(path.join(location, "package.json")));
  }
  return found;
}

/**
 * Where Node finds `name` when it's imported from a file in `fromDir`: the
 * nearest node_modules/<name> going up, no further than the repository.
 *
 * @param {string} name
 * @param {string} fromDir
 */
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
    }
    if (dir === repo || path.dirname(dir) === dir) return null;
  }
}

/**
 * A package's path under out/engine: the same path below node_modules as in
 * the repository, which keeps nested copies nested.
 *
 * @param {string} location
 */
function destinationOf(location) {
  for (const base of [path.join(repo, "node_modules"), path.join(appDir, "node_modules")]) {
    const rel = path.relative(base, location);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return path.join("node_modules", rel);
  }
  return fail(`${location} isn't under a node_modules folder of this repository (a linked package?).`);
}

/**
 * @param {string} rel path inside the package, with forward slashes
 * @param {boolean} isDir
 */
function keepInPackage(rel, isDir) {
  // Nested node_modules are copied as packages of their own, when needed.
  if (isDir) return rel !== "node_modules" && !rel.endsWith("/node_modules") && rel !== ".github";
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return LICENSE_FILE.test(base) || !UNUSED_FILE.test(base);
}

/**
 * node-pty, for the Terminal tab. It's a native module, but a Node-API one
 * whose package carries prebuilt binaries, so the same files load in
 * Electron and need no rebuild. Only its JavaScript and this architecture's
 * binaries are kept (no sources, debug symbols or other platforms), and its
 * one dependency is build-time headers, so none are walked.
 */
function stageNodePty() {
  const location = resolvePackage("node-pty", appDir);
  if (!location) fail("node-pty isn't installed, so the Terminal tab would break. Run npm install first.");
  const prebuilds = `prebuilds/win32-${arch}`;
  const roots = ["lib", prebuilds];
  copyPackage(location, path.join(out, destinationOf(location)), (rel, isDir) => {
    if (isDir) return roots.some((r) => r === rel || r.startsWith(`${rel}/`) || rel.startsWith(`${r}/`));
    if (rel === "package.json" || LICENSE_FILE.test(rel)) return true;
    if (rel.startsWith("lib/")) return rel.endsWith(".js") && !rel.endsWith(".test.js");
    return rel.startsWith(`${prebuilds}/`) && !rel.endsWith(".pdb");
  });
  const staged = path.join(out, destinationOf(location), prebuilds);
  for (const binary of ["pty.node", "conpty.node", "conpty/conpty.dll"]) {
    if (!fs.existsSync(path.join(staged, binary))) fail(`node-pty has no ${prebuilds}/${binary}; the Terminal tab would break.`);
  }
}

/**
 * @param {string} from
 * @param {string} to
 * @param {(rel: string, isDir: boolean) => boolean} keep
 */
function copyPackage(from, to, keep) {
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = path.relative(from, src).split(path.sep).join("/");
      return rel === "" || keep(rel, fs.statSync(src).isDirectory());
    },
  });
}

/** @param {string} dir */
function measure(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return { files, bytes };
}

/**
 * Whether `dir` is what an earlier run left: this package's trimmed manifest
 * (no workspaces, unlike the repository's own) beside a src/core.
 *
 * @param {string} dir
 */
function isStage(dir) {
  try {
    const manifest = readJson(path.join(dir, "package.json"));
    return manifest.name === root.name && !manifest.workspaces && fs.existsSync(path.join(dir, "src", "core"));
  } catch {
    return false;
  }
}

/**
 * The value after a command-line flag, if the flag is there.
 *
 * @param {string} flag
 */
function option(flag) {
  const at = process.argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) fail(`${flag} needs a value.`);
  return value;
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`stage-engine: ${message}`);
  process.exit(1);
}
