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
 * run.js — CLI command for headless, one-shot task execution, on the engine.
 */

import path from "node:path";
import { loadConfig } from "../config/settings.js";
import { Session } from "../core/session.js";
import { snapshotSettings } from "../core/settings.js";
import { c, badge, separator } from "../utils/ui.js";

/**
 * @param {string} taskPrompt
 * @param {{ dir?: string }} [opts]
 * @param {{ createClient?: (opts: any) => any, exit?: (code: number) => void }} [deps]
 *   test seams: a fake client factory, and a replacement for process.exit
 */
export async function runCommand(taskPrompt, opts = {}, deps = {}) {
  const exit = deps.exit || ((code) => process.exit(code));

  if (!taskPrompt || taskPrompt.trim() === "") {
    console.error(`${badge.fail} Please provide a task prompt. Example: kumo run "inspect the repo and write tests"`);
    exit(1);
    return;
  }

  const workspace = path.resolve(opts.dir || process.cwd());
  const settings = snapshotSettings(loadConfig());

  console.log(`\n${c.bold}KUMO Task Execution${c.reset}`);
  console.log(separator(50));
  console.log(`  ${c.dim}Workspace:${c.reset} ${workspace}`);
  console.log(`  ${c.dim}Provider:${c.reset}  ${settings.orchestratorProvider}`);
  console.log(`  ${c.dim}Task:${c.reset}      ${taskPrompt}\n`);

  // A one-shot run is not a chat: nothing is recorded, and nobody is at the
  // keyboard, so approval requests are declined with a note.
  const session = new Session({
    workspace,
    settings,
    persist: false,
    interactive: false,
    quotas: false,
    ...(deps.createClient ? { createClient: deps.createClient } : {}),
  });
  let endsWithNewline = true;
  session.on("event", (e) => {
    switch (e.type) {
      case "turn.delta":
        process.stdout.write(e.text);
        endsWithNewline = e.text.endsWith("\n");
        break;
      case "tool.started":
        console.error(
          `${c.dim}[${e.role || "worker"}] ${e.name}${e.model ? ` (${e.model})` : ""}${e.task ? `: ${e.task.slice(0, 80)}` : ""}${c.reset}`
        );
        break;
      case "session.warning":
        console.error(`\n${badge.warn} ${e.message}`);
        break;
      case "session.notice":
        console.error(`${badge.info} ${e.message}`);
        break;
      case "session.error":
        console.error(`\n${badge.fail} ${e.message}`);
        break;
      default:
        break;
    }
  });

  const onSigint = () => {
    console.error(`\n${badge.warn} Interrupting…`);
    session.interrupt();
  };
  process.once("SIGINT", onSigint);

  let ok = false;
  try {
    await session.start();
    const outcome = await session.send(taskPrompt);
    ok = outcome.ok;
    if (!endsWithNewline) process.stdout.write("\n");
    if (!ok) console.error(`\n${badge.fail} Turn ended without completion: ${outcome.reason}`);
  } catch (err) {
    console.error(`\n${badge.fail} Task execution failed: ${err.message}`);
    ok = false;
  } finally {
    process.off("SIGINT", onSigint);
    await session.stop().catch(() => {});
  }

  exit(ok ? 0 : 1);
}
