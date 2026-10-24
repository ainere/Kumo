/**
 * Serves background scenes from their own origin, kumo-scene://scene/.
 *
 * The renderer shows them in an iframe sandboxed to scripts only, so a scene
 * gets an opaque origin: no preload, no Node, no access to the window around
 * it. Its page carries its own CSP (no network, no frames, scripts from this
 * scheme only), which a srcdoc frame couldn't have: it would inherit the
 * window's CSP and its inline scripts would be blocked. Phase 3c serves
 * theme scenes compiled from a theme folder the same way.
 */

import { protocol } from "electron";
import runtime from "./scenes/runtime.js?raw";
import clouds from "./scenes/clouds.js?raw";
import nightSky from "./scenes/night-sky.js?raw";

export const SCENE_SCHEME = "kumo-scene";
export const SCENE_URL = `${SCENE_SCHEME}://scene/`;

// The runtime first: it defines defineScene() for the scene files after it.
const SCRIPTS: Record<string, string> = {
  "/runtime.js": runtime,
  "/scenes/clouds.js": clouds,
  "/scenes/night-sky.js": nightSky,
};

const PAGE = [
  "<!doctype html><html><head><meta charset=\"utf-8\">",
  "<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style>",
  "</head><body>",
  ...Object.keys(SCRIPTS).map((path) => `<script src="${path}"></script>`),
  "</body></html>",
].join("");

const BASE_HEADERS = {
  "Content-Security-Policy": `default-src 'none'; script-src ${SCENE_SCHEME}:; style-src 'unsafe-inline'`,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/** Before app ready: the scheme needs standard-URL and secure-context rules. */
export function registerSceneScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCENE_SCHEME, privileges: { standard: true, secure: true } }]);
}

export function handleSceneScheme(): void {
  protocol.handle(SCENE_SCHEME, (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(PAGE, { headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
    }
    const script = Object.hasOwn(SCRIPTS, pathname) ? SCRIPTS[pathname] : undefined;
    if (script !== undefined) {
      return new Response(script, { headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404, headers: BASE_HEADERS });
  });
}
