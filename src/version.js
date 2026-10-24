/**
 * version.js — The Kumo version, read once from package.json.
 *
 * Kept apart from cli.js so the MCP bridge and provider clients can name the
 * version without importing the CLI router — which pulls in commander and every
 * command, and closed an import cycle (cli → start → registry → codex-client → cli).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));

export const VERSION = pkg.version;
