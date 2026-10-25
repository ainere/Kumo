/**
 * window-launcher.js — Launches Kumo in a dedicated external terminal window (PowerShell or CMD).
 * The terminal it was started from is left open.
 */

import { spawn } from "node:child_process";
import path from "node:path";

const SAFE_ARG_RE = /^[A-Za-z0-9._:\\/=@+-]+$/;

/**
 * Quote a string for AppleScript double-quoted string literal context.
 * Escapes backslashes first, then double quotes.
 *
 * @param {*} s
 * @returns {string}
 */
function applescriptQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Quote a string as a PowerShell single-quoted literal: nothing inside it is
 * expanded, so `$env:X` and `$(...)` in a folder name stay text. PowerShell
 * also treats the typographic single quotes as quote characters; each of them
 * is escaped, like the plain one, by doubling it.
 *
 * @param {*} s
 * @returns {string}
 */
function powershellQuote(s) {
  return `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;
}

/**
 * Quote a string as a POSIX shell single-quoted word, so `$(...)`, backticks
 * and `$VAR` in a folder name are not expanded by sh or zsh.
 *
 * @param {*} s
 * @returns {string}
 */
function posixQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * The PowerShell script run in the new Windows terminal. `args` are tokens
 * already validated against SAFE_ARG_RE.
 *
 * @param {string} workspace
 * @param {string[]} args
 * @returns {string}
 */
export function buildWindowsLaunchScript(workspace, args) {
  const winCmd = ["kumo", "--here", ...args].join(" ");
  return `$host.UI.RawUI.WindowTitle = 'KUMO — 雲'; Set-Location -LiteralPath ${powershellQuote(workspace)}; ${winCmd}`;
}

/**
 * The AppleScript run by osascript to open Terminal on macOS. The shell command
 * is built first, with the workspace single-quoted for sh, and then quoted once
 * as an AppleScript string. `args` are tokens already validated against
 * SAFE_ARG_RE.
 *
 * @param {string} workspace
 * @param {string[]} args
 * @returns {string}
 */
export function buildMacLaunchScript(workspace, args) {
  const kumoCmd = ["kumo", "--here", ...args].join(" ");
  const innerShellCommand = `cd ${posixQuote(workspace)} && ${kumoCmd}`;
  return `tell application "Terminal" to do script ${applescriptQuote(innerShellCommand)}`;
}

/**
 * Encode a PowerShell script into a base64-encoded UTF-16LE string for -EncodedCommand.
 *
 * @param {string} script
 * @returns {string}
 */
function encodePowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Launch a dedicated new terminal window running Kumo, then exit this process.
 *
 * Supports two calling conventions:
 * 1. Single options object: launchInNewWindow({ workspace, args })
 * 2. Positional arguments: launchInNewWindow(workspace, args)
 *
 * @param {Object|string} [optsOrWorkspace] - Options object or workspace path
 * @param {string[]} [maybeArgs] - Additional CLI arguments when positional convention is used
 * @returns {Promise<boolean>} - true if window launch succeeded
 */
export async function launchInNewWindow(optsOrWorkspace = {}, maybeArgs = undefined) {
  let workspace;
  let passArgs;

  if (typeof optsOrWorkspace === "string") {
    workspace = path.resolve(optsOrWorkspace || process.cwd());
    passArgs = Array.isArray(maybeArgs) ? maybeArgs : [];
  } else {
    const opts = optsOrWorkspace || {};
    workspace = path.resolve(opts.workspace || process.cwd());
    passArgs = Array.isArray(opts.args) ? opts.args : (Array.isArray(maybeArgs) ? maybeArgs : []);
  }

  // Filter out flags that shouldn't propagate
  const cleanArgs = passArgs.filter(
    (a) => a !== "--new-window" && a !== "-w" && a !== "--here" && a !== "start"
  );

  // Validate each argument against safe character set to prevent command injection
  for (const arg of cleanArgs) {
    if (!SAFE_ARG_RE.test(arg)) {
      console.error(`[kumo] window launcher: rejected unsafe argument: ${JSON.stringify(arg)}`);
      return false;
    }
  }

  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";

  if (isWin) {
    // Build PowerShell script and encode via base64 UTF-16LE (-EncodedCommand)
    const encodedCommand = encodePowerShellCommand(buildWindowsLaunchScript(workspace, cleanArgs));

    return new Promise((resolve) => {
      let child;
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
            "-EncodedCommand",
            encodedCommand,
          ],
          {
            cwd: workspace,
            detached: true,
            stdio: "ignore",
          }
        );
      } catch {
        resolve(false);
        return;
      }

      let resolved = false;

      child.once("error", () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });

      child.once("spawn", () => {
        child.unref();
        if (!resolved) {
          resolved = true;
          // The calling shell is left alone. It used to be force-killed
          // (`taskkill /F` on the parent cmd.exe), which took the user's
          // shell — and anything else running in it — down with it.
          setTimeout(() => process.exit(0), 100);
          resolve(true);
        }
      });
    });
  }

  if (isMac) {
    const script = buildMacLaunchScript(workspace, cleanArgs);

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      } catch {
        resolve(false);
        return;
      }

      let resolved = false;
      child.once("error", () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
      });

      child.once("spawn", () => {
        child.unref();
        if (!resolved) {
          resolved = true;
          setTimeout(() => {
            process.exit(0);
          }, 100);
          resolve(true);
        }
      });
    });
  }

  // Linux fallback: try each terminal, advancing on async spawn errors.
  // Resolve true only inside child.once("spawn"); resolve false when all fail.
  const terminals = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
  return new Promise((resolve) => {
    const tryTerm = (i) => {
      if (i >= terminals.length) {
        resolve(false);
        return;
      }
      let child;
      try {
        child = spawn(terminals[i], ["-e", "kumo", "--here", ...cleanArgs], {
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
        resolve(true);
      });
    };
    tryTerm(0);
  });
}

