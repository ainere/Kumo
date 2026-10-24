/**
 * The engine, running in an Electron utilityProcess so a stuck provider CLI
 * or a crash can never freeze the window.
 *
 * It loads src/core from disk (see electron.vite.config.mjs for why it is not
 * bundled), serves the command router over every MessagePort the main
 * process hands it, and broadcasts every engine event to all of them.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { MessagePortMain } from "electron";

const root = process.env.KUMO_ENGINE_ROOT;
if (!root) throw new Error("KUMO_ENGINE_ROOT is not set");

const load = (relative: string) => import(/* @vite-ignore */ pathToFileURL(join(root, relative)).href);

const [{ SessionManager }, { createCommandRouter }] = await Promise.all([
  load("core/session-manager.js"),
  load("core/commands.js"),
]);

// End-to-end tests swap in a scripted orchestrator. Both variables are
// required, so a stray one cannot change what a real session talks to.
const testClientModule =
  process.env.KUMO_E2E === "1" && process.env.KUMO_E2E_CLIENT
    ? await import(/* @vite-ignore */ pathToFileURL(process.env.KUMO_E2E_CLIENT).href)
    : null;

const manager = new SessionManager(
  testClientModule ? { sessionOptions: { createClient: testClientModule.createClient } } : {}
);
const run: (name: string, args?: unknown) => Promise<unknown> = createCommandRouter(manager);
const ports = new Set<MessagePortMain>();

manager.on("event", (event: unknown) => {
  for (const port of ports) port.postMessage({ event });
});

function attach(port: MessagePortMain): void {
  ports.add(port);
  port.on("message", async ({ data }) => {
    const { id, command, args } = (data ?? {}) as { id?: unknown; command?: unknown; args?: unknown };
    if (typeof id !== "number" || typeof command !== "string") return;
    try {
      const result = await run(command, args);
      port.postMessage({ id, result: result ?? null });
    } catch (err) {
      port.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    }
  });
  port.on("close", () => ports.delete(port));
  port.start();
}

process.parentPort.on("message", ({ data, ports: transferred }) => {
  const type = (data as { type?: string } | null)?.type;
  if (type === "port" && transferred[0]) attach(transferred[0]);
  else if (type === "shutdown") void shutdown();
});

const shutdown = async () => {
  await manager.closeAll().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
