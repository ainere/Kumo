/**
 * window-launcher.js — Launches Kumo in a dedicated external terminal window (PowerShell or CMD)
 * and closes the old calling terminal to keep the workspace clean.
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Quote a string for PowerShell single-quoted context.
 *
 * @param {*} s
 * @returns {string}
 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Quote CLI args: bare non-space tokens pass through, others double-quoted.
 *
 * @param {string[]} args
 * @returns {string}
 */
function quoteArgs(args) {
  return args.map((a) => (/^\S+$/.test(a) ? a : `"${String(a).replace(/"/g, '`"')}"`)).join(" ");
}

/**
 * Launch a dedicated new terminal window running Kumo and close the parent console.
 *
 * @param {Object} opts
 * @param {string} [opts.workspace] - Working directory for the new window
 * @param {string[]} [opts.args] - Additional CLI arguments
 * @returns {boolean} - true if window launch was initiated
 */
export function launchInNewWindow(opts = {}) {
  const workspace = path.resolve(opts.workspace || process.cwd());
  const passArgs = opts.args || [];

  // Filter out flags that shouldn't propagate
  const cleanArgs = passArgs.filter(
    (a) => a !== "--new-window" && a !== "-w" && a !== "--here" && a !== "start"
  );
  const trailing = cleanArgs.length > 0 ? ` ${quoteArgs(cleanArgs)}` : "";
  const kumoCmd = `kumo --here${trailing}`;

  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  if (isWin) {
    const winCmd = `kumo --here${trailing}`;

    // Spawn a fresh PowerShell window running Kumo (fail-closed on sync errors)
    let child;
    let failed = false;
    try {
      child = spawn(
        "cmd.exe",
        [
          "/c",
          "start",
          "KUMO — 雲",
          "powershell.exe",
          "-NoProfile",
          "-NoExit",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          `$host.UI.RawUI.WindowTitle = 'KUMO — 雲'; Set-Location ${psQuote(workspace)}; ${winCmd}`,
        ],
        {
          cwd: workspace,
          detached: true,
          stdio: "ignore",
        }
      );
    } catch {
      return false;
    }
    child.on("error", () => {
      failed = true;
    });
    child.unref();

    // Close the old calling CMD window only if it is safe
    const ppid = process.ppid;
    if (ppid && ppid > 1) {
      setTimeout(() => {
        if (failed || !child.pid) return;
        let safeToKill = false;
        try {
          const probe = execSync(
            `tasklist /FI "PID eq ${Number(ppid)}" /FO CSV /NH`,
            { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
          );
          safeToKill = /cmd\.exe|conhost\.exe/i.test(probe);
        } catch {
          safeToKill = false;
        }
        if (safeToKill) {
          try {
            spawn("taskkill.exe", ["/F", "/PID", String(ppid)], {
              detached: true,
              stdio: "ignore",
            }).unref();
          } catch {
            return;
          }
        }
        process.exit(0);
      }, 100);
    } else if (!failed && child.pid) {
      process.exit(0);
    } else {
      return false;
    }
    return true;
  }

  if (isMac) {
    const script = `tell application "Terminal" to do script "cd ${psQuote(workspace)} && ${kumoCmd}"`;
    let child;
    try {
      child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    } catch {
      return false;
    }
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    child.unref();
    if (failed || !child.pid) return false;
    setTimeout(() => {
      if (!failed) process.exit(0);
    }, 100);
    return true;
  }

  // Linux fallback: try each terminal, advancing on async spawn errors.
  // Exit only after a terminal reports a successful spawn.
  const terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
  const tryTerm = (i) => {
    if (i >= terminals.length) return;
    let child;
    try {
      child = spawn(terminals[i], ["-e", kumoCmd], {
        cwd: workspace,
        detached: true,
        stdio: "ignore",
      });
    } catch {
      tryTerm(i + 1);
      return;
    }
    child.once("error", () => {
      tryTerm(i + 1);
    });
    child.once("spawn", () => {
      child.unref();
      process.exit(0);
    });
  };
  tryTerm(0);

  return true;
}
