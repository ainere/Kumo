/**
 * Serves background scenes from their own origin, kumo-scene://scene/.
 *
 * The renderer shows them in an iframe sandboxed to scripts only, so a scene
 * gets an opaque origin: no preload, no Node, no access to the window around
 * it. Its page carries its own CSP (no network, no frames, scripts from this
 * scheme only), which a srcdoc frame couldn't have: it would inherit the
 * window's CSP and its inline scripts would be blocked.
 *
 * Besides the built-in scenes, every `<KUMO_HOME>/scenes/*.js` file is loaded
 * as a scene script, so people can run scenes of their own (or ones they
 * aren't allowed to redistribute) without them ever entering the app.
 * Phase 3c adds theme packages with TypeScript and hot reload on top.
 */

import { protocol } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import runtime from "./scenes/runtime.js?raw";
import clouds from "./scenes/clouds.js?raw";
import nightSky from "./scenes/night-sky.js?raw";

export const SCENE_SCHEME = "kumo-scene";
export const SCENE_URL = `${SCENE_SCHEME}://scene/`;

// The runtime first: it defines defineScene() for the scene files after it.
const BUILT_IN: Record<string, string> = {
  "/runtime.js": runtime,
  "/scenes/clouds.js": clouds,
  "/scenes/night-sky.js": nightSky,
};

const USER_SCENE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
const MAX_USER_SCENE_BYTES = 4 * 1024 * 1024;

/** The same directory as src/config/paths.js kumoHome(). */
function userScenesDir(): string {
  const override = process.env.KUMO_HOME;
  const home = override && override.trim() !== "" ? path.resolve(override) : path.join(os.homedir(), ".kumo");
  return path.join(home, "scenes");
}

function userSceneFiles(): string[] {
  try {
    return fs
      .readdirSync(userScenesDir())
      .filter((name) => USER_SCENE_FILE.test(name))
      .sort();
  } catch {
    return [];
  }
}

function page(): string {
  const scripts = [...Object.keys(BUILT_IN), ...userSceneFiles().map((name) => `/user/${name}`)];
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style>",
    "</head><body>",
    ...scripts.map((src) => `<script src="${src}"></script>`),
    "</body></html>",
  ].join("");
}

function readUserScene(name: string): string | undefined {
  if (!USER_SCENE_FILE.test(name)) return undefined;
  const file = path.join(userScenesDir(), name);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_USER_SCENE_BYTES) return undefined;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

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
      return new Response(page(), { headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
    }
    const script = Object.hasOwn(BUILT_IN, pathname)
      ? BUILT_IN[pathname]
      : pathname.startsWith("/user/")
        ? readUserScene(pathname.slice("/user/".length))
        : undefined;
    if (script !== undefined) {
      return new Response(script, { headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404, headers: BASE_HEADERS });
  });
}
