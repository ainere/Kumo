import { useEffect, useRef, useState } from "react";
import { detectLocalhost, toastFailure, useStore } from "../../store";
import type { BrowserViewState } from "../../types";
import { IconArrowLeft, IconArrowRight, IconRefresh } from "../icons";

/** How often the tab looks for a dev server that just came up. */
const SCAN_MS = 4000;

const NO_PAGE: BrowserViewState = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, error: null };

export function BrowserTab() {
  const servers = useStore((s) => s.localhostServers);
  // The page is a native view above everything in this window, so it steps
  // aside for whatever needs to draw there, and for a drag on the dock's edge,
  // which it would otherwise swallow.
  const covered = useStore(
    (s) =>
      s.view === "settings" ||
      s.paletteMode !== null ||
      s.providerSwitch !== null ||
      s.dialogOpen ||
      s.workbenchResizing
  );

  const [urlInput, setUrlInput] = useState("");
  const [page, setPage] = useState<BrowserViewState>(NO_PAGE);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void detectLocalhost();
    const timer = setInterval(() => void detectLocalhost(), SCAN_MS);
    const show = (state: BrowserViewState) => {
      setPage(state);
      if (state.url) setUrlInput(state.url);
      // The page being viewed keeps its pill, on a port the usual scan doesn't try too.
      const local = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/i.exec(state.url);
      if (local) void detectLocalhost([Number(local[1])]);
    };
    void window.kumo.app.browser.state().then(show);
    const off = window.kumo.app.browser.onState(show);
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  const showPage = !covered && Boolean(page.url) && !page.error;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const sync = () => {
      const rect = el.getBoundingClientRect();
      void window.kumo.app.browser.bounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        visible: showPage && rect.width > 10 && rect.height > 10,
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void window.kumo.app.browser.bounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [showPage]);

  const navigateTo = async (target: string) => {
    const clean = target.trim();
    if (!clean) return;
    try {
      const state = await window.kumo.app.browser.navigate(clean);
      setPage(state);
      if (state.url) setUrlInput(state.url);
    } catch (err) {
      toastFailure(err);
    }
  };

  return (
    <div className="wb-browser" data-part="workbench-browser">
      <form
        className="wb-browser-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void navigateTo(urlInput);
        }}
      >
        <button
          type="button"
          className="wb-icon-btn"
          aria-label="Back"
          disabled={!page.canGoBack}
          onClick={() => void window.kumo.app.browser.back()}
        >
          <IconArrowLeft />
        </button>
        <button
          type="button"
          className="wb-icon-btn"
          aria-label="Forward"
          disabled={!page.canGoForward}
          onClick={() => void window.kumo.app.browser.forward()}
        >
          <IconArrowRight />
        </button>
        <button
          type="button"
          className="wb-icon-btn"
          aria-label="Reload"
          disabled={!page.url}
          onClick={() => void window.kumo.app.browser.reload()}
        >
          <IconRefresh />
        </button>
        <input
          type="text"
          className="wb-search-input wb-url-input"
          aria-label="Browser URL"
          placeholder="localhost:3000 or a web address"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
        />
      </form>

      {servers.length > 0 && (
        <div className="wb-localhost-strip" data-part="localhost-servers">
          <span className="muted small">Running here:</span>
          {servers.map((srv) => (
            <button
              key={srv.port}
              type="button"
              className="wb-port-pill"
              title={srv.url}
              onClick={() => void navigateTo(srv.url)}
            >
              :{srv.port}
            </button>
          ))}
        </div>
      )}

      <div className="wb-browser-stage" ref={stageRef} data-part="browser-stage">
        {page.error ? (
          <div className="wb-browser-note" data-part="browser-error">
            <p className="small">Couldn't load {page.error.url}</p>
            <p className="muted small mono">{page.error.description}</p>
            <button type="button" className="wb-mini-btn" onClick={() => void navigateTo(page.error?.url ?? "")}>
              Try again
            </button>
          </div>
        ) : (
          !page.url && (
            <div className="wb-browser-note muted small">
              {servers.length > 0
                ? "Pick a server above, or type an address."
                : "Start a dev server in the Terminal tab and it shows up here, or type an address above."}
            </div>
          )
        )}
      </div>
    </div>
  );
}
