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
 * The app checks at start and every few hours. Builds aren't code-signed yet,
 * so the only check on a downloaded update would be a hash that comes from
 * the same release. Until they are signed the app neither downloads nor
 * installs an update: Windows shows one notification that a newer version is
 * out, and a click opens the release page. Until a release exists a check
 * finds nothing and stays quiet. A development build, or one started with
 * KUMO_NO_UPDATES=1, never checks. Nothing here publishes anything.
 */

import { app, Notification, shell } from "electron";
// CommonJS, and its exports are getters a named import can't see.
import electronUpdater from "electron-updater";

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const RELEASES_URL = "https://github.com/ainere/Kumo/releases/latest";

/** Kept while it is on screen, or it could be collected before it is clicked. */
let shown: Notification | null = null;
/** The version already announced in this run; the check repeats every few hours. */
let announced = "";

function announce(version: string): void {
  if (version === announced || !Notification.isSupported()) return;
  announced = version;
  const note = new Notification({
    title: `Kumo ${version} is available`,
    body: "Click to open the download page on GitHub.",
  });
  note.on("click", () => void shell.openExternal(RELEASES_URL));
  note.on("close", () => {
    if (shown === note) shown = null;
  });
  shown = note;
  note.show();
}

export function startUpdateChecks(): void {
  if (!app.isPackaged || process.env.KUMO_NO_UPDATES === "1") return;
  const { autoUpdater } = electronUpdater;
  // Its default logger writes every step to the console; only failures matter.
  autoUpdater.logger = null;
  // Unsigned builds: say that an update exists, and leave getting it to the user.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Without a listener an "error" event would throw in the main process.
  autoUpdater.on("error", (err) => console.warn(`kumo: update check failed: ${err?.message ?? err}`));
  autoUpdater.on("update-available", (info) => announce(info.version));
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY_MS).unref();
}
