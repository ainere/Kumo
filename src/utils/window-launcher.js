/**
 * window-launcher.js — Launches Kumo in a dedicated external terminal window,
 * preserving parent shell history and providing an isolated session window.
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { badge, c } from "./ui.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const CLI_BIN = path.join(ROOT_DIR, "bin/kumo.js");

/**
 * Launch a dedicated new terminal window running Kumo.
 *
 * @param {Object} opts
 * @param {string} [opts.workspace] - Working directory for the new window
 * @param {string[]} [opts.args] - Additional CLI arguments
 * @returns {boolean} - true if window launch was initiated
 */
export function launchInNewWindow(opts = {}) {
  const workspace = path.resolve(opts.workspace || process.cwd());
  const passArgs = opts.args || [];

  // Filter out any recursive --new-window or -w flags and add --here flag
  const cleanArgs = passArgs.filter((a) => a !== "--new-window" && a !== "-w");
  const childArgs = ["start", "--here", "-C", workspace, ...cleanArgs];

  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  if (isWin) {
    // Try Windows Terminal (wt.exe) first
    let hasWt = false;
    try {
      execSync("where.exe wt.exe", { stdio: "ignore" });
      hasWt = true;
    } catch {
      hasWt = false;
    }

    if (hasWt) {
      const wtArgs = [
        "--title",
        "Kumo Orchestrator",
        "-d",
        workspace,
        "node",
        CLI_BIN,
        ...childArgs,
      ];

      const child = spawn("wt.exe", wtArgs, {
        cwd: workspace,
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      console.log(`\n${badge.ok} Opened Kumo in a new ${c.bold}Windows Terminal${c.reset} window.`);
      console.log(`  ${c.dim}Workspace:${c.reset} ${workspace}`);
      console.log(`  ${c.dim}Your current console history is preserved.${c.reset}\n`);
      return true;
    }

    // Fall back to cmd.exe start
    const cmdArgs = [
      "/c",
      "start",
      "Kumo Orchestrator",
      "node",
      CLI_BIN,
      ...childArgs,
    ];

    const child = spawn("cmd.exe", cmdArgs, {
      cwd: workspace,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    console.log(`\n${badge.ok} Opened Kumo in a dedicated console window.`);
    console.log(`  ${c.dim}Workspace:${c.reset} ${workspace}`);
    console.log(`  ${c.dim}Your current console history is preserved.${c.reset}\n`);
    return true;
  }

  if (isMac) {
    const cmd = `node "${CLI_BIN}" ${childArgs.join(" ")}`;
    const script = `tell application "Terminal" to do script "cd '${workspace}' && ${cmd}"`;
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();

    console.log(`\n${badge.ok} Opened Kumo in a new macOS Terminal window.\n`);
    return true;
  }

  // Linux fallback
  const terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
  for (const term of terminals) {
    try {
      execSync(`which ${term}`, { stdio: "ignore" });
      const child = spawn(term, ["-e", "node", CLI_BIN, ...childArgs], {
        cwd: workspace,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      console.log(`\n${badge.ok} Opened Kumo in a new ${term} window.\n`);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}
