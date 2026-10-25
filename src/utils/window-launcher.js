/**
 * window-launcher.js — Launches Kumo in a dedicated external terminal window (PowerShell or CMD).
 * The terminal it was started from is left open.
 */

import { spawn } from "node:child_process";
import os from "node:os";
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
 * already validated against SAFE_ARG_RE, and each is single-quoted so none is
 * parsed as PowerShell syntax (`@name` would otherwise splat).
 *
 * @param {string} workspace
 * @param {string[]} args
 * @returns {string}
 */
export function buildWindowsLaunchScript(workspace, args) {
  const winCmd = ["kumo", "--here", ...args.map(powershellQuote)].join(" ");
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
        setTimeout(() => process.exit(0), 100);
        resolve(true);
      });
    };
    tryTerm(0);
  });
}

// ── Run one command in a new terminal, leaving this process alone ──

/** Window titles go to the terminal and, on Windows, to cmd's `start`; keep them plain. */
const SAFE_TITLE_RE = /^[A-Za-z0-9 ._-]{1,60}$/;

/**
 * Why `argv` cannot be run in a new terminal, or null when it can. Every
 * element must be in the SAFE_ARG_RE alphabet (no spaces, quotes, `;`, `&`,
 * `$`, backticks): the command is built into a shell script, and nothing a
 * caller passes may become shell syntax.
 *
 * @param {unknown} argv
 * @param {unknown} [title]
 * @returns {string|null}
 */
export function terminalCommandProblem(argv, title) {
  if (!Array.isArray(argv) || argv.length === 0) return "no command to run";
  for (const arg of argv) {
    if (typeof arg !== "string" || !SAFE_ARG_RE.test(arg)) return `unsafe argument ${JSON.stringify(arg)}`;
  }
  if (title !== undefined && (typeof title !== "string" || !SAFE_TITLE_RE.test(title))) {
    return `unsafe window title ${JSON.stringify(title)}`;
  }
  return null;
}

/**
 * The PowerShell script run in a new Windows terminal for one command. Each
 * token is single-quoted and run through the call operator, so none of it is
 * ever parsed as PowerShell syntax (`@name` would otherwise splat).
 *
 * @param {string} cwd
 * @param {string[]} argv - already validated, see {@link terminalCommandProblem}
 * @param {string} title
 * @returns {string}
 */
export function buildWindowsCommandScript(cwd, argv, title) {
  return `$host.UI.RawUI.WindowTitle = ${powershellQuote(title)}; Set-Location -LiteralPath ${powershellQuote(cwd)}; & ${argv.map(powershellQuote).join(" ")}`;
}

/**
 * The AppleScript run by osascript to open Terminal on macOS for one command.
 * Terminal keeps the window open once the command ends.
 *
 * @param {string} cwd
 * @param {string[]} argv - already validated, see {@link terminalCommandProblem}
 * @returns {string}
 */
export function buildMacCommandScript(cwd, argv) {
  const shellCommand = `cd ${posixQuote(cwd)} && ${argv.map(posixQuote).join(" ")}`;
  return `tell application "Terminal"\nactivate\ndo script ${applescriptQuote(shellCommand)}\nend tell`;
}

/**
 * The sh script a Linux terminal runs for one command: the command, then an
 * interactive shell, so the window stays open to show how it ended.
 *
 * @param {string[]} argv - already validated, see {@link terminalCommandProblem}
 * @returns {string}
 */
export function buildPosixCommandScript(argv) {
  return `${argv.map(posixQuote).join(" ")}; exec "\${SHELL:-sh}"`;
}

/**
 * The argument list for `cmd.exe` that opens `argv` in a new PowerShell window.
 *
 * `start`'s first quoted argument is the window title, and an unquoted first
 * word is taken as the program to run instead: with `title` in that slot, a
 * one-word title such as "Kumo" would start whatever `Kumo` resolves to on PATH
 * (a `kumo.cmd`, say) and the real command would never run. So the title slot
 * is always the empty string, which Node passes as `""`; the window is titled
 * by the PowerShell script itself.
 *
 * @param {string} cwd
 * @param {string[]} argv - already validated, see {@link terminalCommandProblem}
 * @param {string} title
 * @returns {string[]}
 */
export function buildWindowsTerminalArgv(cwd, argv, title) {
  return [
    "/c",
    "start",
    "",
    "powershell.exe",
    "-NoProfile",
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShellCommand(buildWindowsCommandScript(cwd, argv, title)),
  ];
}

/**
 * Open a new terminal window running `argv`, and leave this process running.
 * (`launchInNewWindow` exits the process once its window is up, which would
 * take the desktop engine down with it.)
 *
 * Used to hand sign-in over to a provider's own login command: the user types
 * their credentials into that CLI, never into Kumo.
 *
 * `env` is the terminal's whole environment, and the shell and the command
 * inherit it. Pass `childEnvFor(provider)` so credentials that belong to other
 * providers are left out; without `env` the terminal inherits this process's
 * environment unchanged.
 *
 * @param {string[]} argv - the command and its arguments, each within SAFE_ARG_RE
 * @param {{
 *   cwd?: string,
 *   title?: string,
 *   env?: Record<string, string|undefined>,
 *   spawnFn?: typeof spawn,
 * }} [opts] - `cwd` defaults to the home directory; `spawnFn` is a test seam
 * @returns {Promise<boolean>} true once a terminal process started; false when the
 *   command was refused or no terminal could be started
 */
export async function launchTerminalCommand(argv, { cwd = os.homedir(), title = "Kumo", env, spawnFn = spawn } = {}) {
  const problem = terminalCommandProblem(argv, title);
  if (problem) {
    console.error(`[kumo] window launcher: refused: ${problem}`);
    return false;
  }
  if (!path.isAbsolute(cwd)) {
    console.error(`[kumo] window launcher: refused: working directory is not absolute: ${JSON.stringify(cwd)}`);
    return false;
  }

  /**
   * Start one terminal process; true once it is running, false if it cannot start.
   *
   * @param {string} file
   * @param {string[]} args
   * @returns {Promise<boolean>}
   */
  const start = (file, args) =>
    new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(file, args, { cwd, detached: true, stdio: "ignore", ...(env ? { env } : {}) });
      } catch {
        resolve(false);
        return;
      }
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });

  if (process.platform === "win32") {
    return start("cmd.exe", buildWindowsTerminalArgv(cwd, argv, title));
  }

  if (process.platform === "darwin") {
    return start("osascript", ["-e", buildMacCommandScript(cwd, argv)]);
  }

  const script = buildPosixCommandScript(argv);
  for (const terminal of ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"]) {
    // gnome-terminal dropped `-e` for a command list; `--` is its form.
    const args = terminal === "gnome-terminal" ? ["--", "sh", "-c", script] : ["-e", "sh", "-c", script];
    if (await start(terminal, args)) return true;
  }
  return false;
}
