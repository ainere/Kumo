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
 * Serves custom panels from kumo-panel://<id>/.
 *
 * The renderer shows each in an iframe sandboxed to scripts only, so like a
 * scene a panel gets an opaque origin: no preload, no Node, no access to the
 * window around it. This CSP keeps it off the network, so nothing it's told can
 * leave the machine. Inline scripts are allowed because a panel is usually one
 * HTML file; `default-src 'none'` still covers fetch, sockets and frames.
 */

import { protocol } from "electron";
import { PANEL_SCHEME, readPanelAsset } from "./user-panels";

const HEADERS = {
  "Content-Security-Policy": [
    "default-src 'none'",
    `script-src ${PANEL_SCHEME}: 'unsafe-inline'`,
    `style-src ${PANEL_SCHEME}: 'unsafe-inline'`,
    `img-src ${PANEL_SCHEME}: data:`,
    `font-src ${PANEL_SCHEME}: data:`,
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

export function handlePanelScheme(): void {
  protocol.handle(PANEL_SCHEME, (request) => {
    const url = new URL(request.url);
    const asset = readPanelAsset(url.hostname, url.pathname);
    if (!asset) return new Response("Not found", { status: 404, headers: HEADERS });
    return new Response(new Uint8Array(asset.body), { headers: { ...HEADERS, "Content-Type": asset.type } });
  });
}
