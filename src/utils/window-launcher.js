/**
 * window-launcher.js — Launches Kumo in a dedicated external terminal window (PowerShell or CMD)
 * and closes the old calling terminal to keep the workspace clean.
 */

import { spawn, execSync } from "node:child_process";
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
 * Encode a PowerShell script into a base64-encoded UTF-16LE string for -EncodedCommand.
 *
 * @param {string} script
 * @returns {string}
 */
function encodePowerShellCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Launch a dedicated new terminal window running Kumo and close the parent console.
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
    // Notice arguments are safe tokens validated by SAFE_ARG_RE.
    const winCmdTokens = ["kumo", "--here", ...cleanArgs];
    const winCmd = winCmdTokens.join(" ");
    const psScript = `$host.UI.RawUI.WindowTitle = 'KUMO — 雲'; Set-Location -LiteralPath ${JSON.stringify(workspace)}; ${winCmd}`;
    const encodedCommand = encodePowerShellCommand(psScript);

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

          // Close old calling CMD window only if it is safe
          const ppid = process.ppid;
          if (ppid && ppid > 1) {
            setTimeout(() => {
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
                } catch {}
              }
              process.exit(0);
            }, 100);
          } else {
            process.exit(0);
          }

          resolve(true);
        }
      });
    });
  }

  if (isMac) {
    // Dedicated applescriptQuote escapes \ and " and double quotes values
    const cdCmd = `cd ${applescriptQuote(workspace)}`;
    const kumoTokens = ["kumo", "--here", ...cleanArgs];
    const kumoCmd = kumoTokens.join(" ");
    const innerShellCommand = `${cdCmd} && ${kumoCmd}`;
    const script = `tell application "Terminal" to do script ${applescriptQuote(innerShellCommand)}`;

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

