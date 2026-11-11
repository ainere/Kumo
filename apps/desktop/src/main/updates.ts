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
 * Updates for the installed app, from the GitHub Releases of ainere/Kumo
 * (`publish` in electron-builder.yml, baked into the package as
 * app-update.yml).
 *
 * The app checks at start and every few hours. An update downloads in the
 * background, Windows shows a notification once it's ready, and it installs
 * when the app quits. Until a release exists a check finds nothing and stays
 * quiet. A development build, or one started with KUMO_NO_UPDATES=1, never
 * checks. Nothing here publishes anything.
 */

import { app } from "electron";
// CommonJS, and its exports are getters a named import can't see.
import electronUpdater from "electron-updater";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export function startUpdateChecks(): void {
  if (!app.isPackaged || process.env.KUMO_NO_UPDATES === "1") return;
  const { autoUpdater } = electronUpdater;
  // Its default logger writes every step to the console; only failures matter.
  autoUpdater.logger = null;
  // Without a listener an "error" event would throw in the main process.
  autoUpdater.on("error", (err) => console.warn(`kumo: update check failed: ${err?.message ?? err}`));
  const check = () => void autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY_MS).unref();
}
