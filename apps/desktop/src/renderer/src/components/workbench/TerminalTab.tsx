import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { detectLocalhost, invoke, useStore } from "../../store";
import { useAppliedTheme } from "../../theme";
import type { KumoEvent, TerminalInfo } from "../../types";

/** What `terminal.input` accepts in one call. Longer pastes go in pieces. */
const MAX_INPUT = 60_000;

const PORT_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{4,5})/g;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

/** The app's colors, so the terminal looks like the rest of the window in either mode. */
function terminalTheme(mode: "dark" | "light"): ITheme {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const text = token("--text");
  const dark = mode === "dark";
  return {
    background: "#00000000",
    foreground: text,
    cursor: token("--accent"),
    cursorAccent: token("--bg"),
    selectionBackground: `color-mix(in srgb, ${token("--accent")} 30%, transparent)`,
    black: dark ? "#5b6478" : text,
    red: token("--bad"),
    green: token("--ok"),
    yellow: token("--warn"),
    blue: token("--accent"),
    magenta: dark ? "#c6a0f6" : "#8839ef",
    cyan: dark ? "#7dcfff" : "#0e7490",
    white: dark ? text : "#5b6478",
    brightBlack: dark ? "#7c869c" : "#5b6478",
    brightRed: token("--bad"),
    brightGreen: token("--ok"),
    brightYellow: token("--warn"),
    brightBlue: token("--accent"),
    brightMagenta: dark ? "#c6a0f6" : "#8839ef",
    brightCyan: dark ? "#7dcfff" : "#0e7490",
    brightWhite: text,
  };
}

/**
 * The workspace's shell. The shell itself runs in the engine and outlives this
 * tab, so leaving the tab leaves a dev server running; coming back replays its
 * recent output.
 */
export function TerminalTab() {
  const workspace = useStore((s) => s.session?.workspace ?? null);
  const { mode } = useAppliedTheme();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const [shell, setShell] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const attach = useRef<(info: TerminalInfo) => void>(() => {});

  useEffect(() => {
    const el = host.current;
    if (!workspace || !el) return;
    let disposed = false;
    let terminalId: string | null = null;

    const terminal = new Terminal({
      allowTransparency: true,
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: terminalTheme(mode),
    });
    term.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);

    // Ctrl+V pastes and Ctrl+Shift+C copies, as in a browser; plain Ctrl+C stays the shell's interrupt.
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey) return true;
      if (e.key.toLowerCase() === "v") return false;
      if (e.key.toLowerCase() === "c" && e.shiftKey) {
        void navigator.clipboard?.writeText(terminal.getSelection());
        return false;
      }
      return true;
    });

    const show = (info: TerminalInfo) => {
      terminalId = info.terminalId;
      setShell(info.shell);
      setExitCode(info.exitCode);
      setFailure(null);
      terminal.reset();
      if (info.buffer) terminal.write(info.buffer);
    };
    attach.current = show;

    terminal.onData((data) => {
      if (!terminalId) return;
      for (let at = 0; at < data.length; at += MAX_INPUT) {
        void invoke("terminal.input", { terminalId, data: data.slice(at, at + MAX_INPUT) }).catch(() => {});
      }
    });
    terminal.onResize(({ cols, rows }) => {
      if (terminalId) void invoke("terminal.resize", { terminalId, cols, rows }).catch(() => {});
    });

    // Each port is looked at once: a log printing one address thousands of times is one server.
    const portsSeen = new Set<number>();

    const off = window.kumo.onEvent((raw) => {
      const event = raw as KumoEvent;
      if (event.type === "terminal.output" && event.terminalId === terminalId) {
        terminal.write(event.data);
        for (const match of event.data.replace(ANSI_RE, "").matchAll(PORT_RE)) {
          const port = Number(match[1]);
          if (port < 1024 || port > 65535 || portsSeen.has(port)) continue;
          portsSeen.add(port);
          void detectLocalhost([port]);
        }
      } else if (event.type === "terminal.exit" && event.terminalId === terminalId) {
        setExitCode(event.exitCode);
      }
    });

    const refit = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    };
    const observer = new ResizeObserver(refit);

    const connect = () => {
      invoke<TerminalInfo>("terminal.open", { workspace, cols: terminal.cols, rows: terminal.rows })
        .then((info) => {
          if (!disposed) show(info);
        })
        .catch((err: unknown) => {
          if (!disposed) setFailure(err instanceof Error ? err.message : String(err));
        });
    };
    // The shell went down with the engine; a new one takes its place.
    const offRestart = window.kumo.onEngineRestart(connect);

    // The cell size is measured when the terminal opens, so the font comes first.
    void document.fonts.load('12px "JetBrains Mono"').finally(() => {
      if (disposed) return;
      terminal.open(el);
      refit();
      observer.observe(el);
      // Opening the tab brings the keyboard here, but an app starting on it leaves the composer alone.
      const active = document.activeElement;
      if (!active || active === document.body || el.closest(".workbench")?.contains(active)) terminal.focus();
      connect();
    });

    return () => {
      disposed = true;
      off();
      offRestart();
      observer.disconnect();
      terminal.dispose();
      term.current = null;
    };
    // Colors follow the theme below, without restarting the view.
  }, [workspace]);

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme(mode);
  }, [mode]);

  const restart = () => {
    const terminal = term.current;
    if (!workspace || !terminal) return;
    void invoke<TerminalInfo>("terminal.restart", { workspace, cols: terminal.cols, rows: terminal.rows })
      .then((info) => attach.current(info))
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="wb-terminal" data-part="workbench-terminal">
      <div className="wb-terminal-toolbar">
        <span className="wb-terminal-cwd" title={workspace ?? ""}>
          {shell || "terminal"}
        </span>
        {exitCode !== null && <span className="wb-terminal-exited">exited ({exitCode})</span>}
        <span className="spacer" />
        <button type="button" className="wb-mini-btn" onClick={() => term.current?.clear()}>
          Clear
        </button>
        <button type="button" className="wb-mini-btn" data-part="terminal-restart" onClick={restart}>
          Restart
        </button>
      </div>
      {failure && <div className="wb-terminal-failure small">{failure}</div>}
      <div className="wb-terminal-view" data-part="terminal-view" onClick={() => term.current?.focus()}>
        <div ref={host} className="wb-terminal-host" data-part="terminal-output" />
      </div>
    </div>
  );
}
