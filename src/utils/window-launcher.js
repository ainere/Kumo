/**
 * window-launcher.js — Launches Kumo in a dedicated external terminal window (PowerShell or CMD)
 * and closes the old calling terminal to keep the workspace clean.
 */

import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const trailing = cleanArgs.length > 0 ? ` ${cleanArgs.join(" ")}` : "";
  const kumoCmd = `kumo --here${trailing}`;

  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  if (isWin) {
    const kumoCmd = `kumo --here${trailing}`;

    // Spawn a fresh PowerShell window running Kumo
    const child = spawn(
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
        `$host.UI.RawUI.WindowTitle = 'KUMO — 雲'; Set-Location '${workspace}'; ${kumoCmd}`,
      ],
      {
        cwd: workspace,
        detached: true,
        stdio: "ignore",
      }
    );
    child.unref();

    // Close the old calling CMD window only if it is safe
    const ppid = process.ppid;
    if (ppid && ppid > 1) {
      setTimeout(() => {
        try {
          const parentName = execSync(
            `wmic process where ProcessId=${ppid} get Name /format:value`,
            { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
          ).trim();

          const safeToKill = /cmd\.exe|conhost\.exe/i.test(parentName);
          if (safeToKill) {
            spawn("taskkill.exe", ["/F", "/PID", String(ppid)], {
              detached: true,
              stdio: "ignore",
            }).unref();
          }
        } catch {
          /* ignore */
        }
        process.exit(0);
      }, 100);
    } else {
      process.exit(0);
    }
    return true;
  }

  if (isMac) {
    const script = `tell application "Terminal" to do script "cd '${workspace}' && ${kumoCmd}"`;
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
    process.exit(0);
    return true;
  }

  // Linux fallback
  const terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
  for (const term of terminals) {
    try {
      const child = spawn(term, ["-e", kumoCmd], {
        cwd: workspace,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      process.exit(0);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}
