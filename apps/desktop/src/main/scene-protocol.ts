/*
 * Copyright (C) 2026 Elkan La Madrid
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Serves background scenes from their own origin, kumo-scene://scene/.
 *
 * The renderer shows them in an iframe sandboxed to scripts only, so a scene
 * gets an opaque origin: no preload, no Node, no access to the window around
 * it. Its page carries its own CSP (no network, no frames, scripts from this
 * scheme only), which a srcdoc frame couldn't have: it would inherit the
 * window's CSP and its inline scripts would be blocked.
 *
 * Besides the built-in scenes, every `<KUMO_HOME>/scenes/*.js` and `*.ts` file
 * is loaded as a scene script (see user-scenes.ts), so people can run scenes
 * of their own (or ones they aren't allowed to redistribute) without them ever
 * entering the app.
 *
 *   /                      every scene: the runtime, the built-ins, the user's
 *   /thumb?src=&mode=&accent=
 *                          the runtime and one scene, for gallery thumbnails;
 *                          the runtime reads mode and accent from the query
 *   /runtime.js, /scenes/*.js, /user/<file>
 *                          the scripts (a .ts scene is served compiled)
 */

import { protocol } from "electron";
import { readUserScene, scanUserScenes } from "./user-scenes";
import runtime from "./scenes/runtime.js?raw";
import clouds from "./scenes/clouds.js?raw";
import nightSky from "./scenes/night-sky.js?raw";

export const SCENE_SCHEME = "kumo-scene";
export const SCENE_URL = `${SCENE_SCHEME}://scene/`;

const RUNTIME = "/runtime.js";

// The runtime first: it defines defineScene() for the scene files after it.
const BUILT_IN: Record<string, string> = {
  [RUNTIME]: runtime,
  "/scenes/clouds.js": clouds,
  "/scenes/night-sky.js": nightSky,
};

/** User scene scripts that can run; a broken one is left out so it can't take the page down. */
function userScripts(): string[] {
  try {
    return scanUserScenes()
      .filter((scene) => !scene.error)
      .map((scene) => scene.src);
  } catch (err) {
    console.error("kumo: can't read the scenes folder:", err);
    return [];
  }
}

function pageFor(scripts: string[]): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}</style>",
    "</head><body>",
    ...scripts.map((src) => `<script src="${src}"></script>`),
    "</body></html>",
  ].join("");
}

function page(): string {
  return pageFor([...Object.keys(BUILT_IN), ...userScripts()]);
}

/** The runtime and one scene. `src` must be a scene the full page would load, never the runtime. */
function thumbPage(src: string | null): string | undefined {
  if (src === null || src === RUNTIME) return undefined;
  const known = Object.hasOwn(BUILT_IN, src) || userScripts().includes(src);
  return known ? pageFor([RUNTIME, src]) : undefined;
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
    const url = new URL(request.url);
    const { pathname } = url;
    const html = (body: string) =>
      new Response(body, { headers: { ...BASE_HEADERS, "Content-Type": "text/html; charset=utf-8" } });
    if (pathname === "/" || pathname === "/index.html") return html(page());
    if (pathname === "/thumb") {
      const thumb = thumbPage(url.searchParams.get("src"));
      if (thumb !== undefined) return html(thumb);
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
