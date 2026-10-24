/**
 * The desktop app end to end: the built Electron app, its real engine in a
 * utility process, and a scripted orchestrator (fake-client.mjs) in place of
 * a provider CLI. Kumo's home is a throwaway directory.
 */

import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Frame, Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "../..");

let app: ElectronApplication;
let page: Page;
let home: string;
let workspace: string;

async function launch(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.ELECTRON_RENDERER_URL;
  Object.assign(env, {
    KUMO_HOME: home,
    KUMO_NO_SYNC: "1",
    KUMO_STRICT_EVENTS: "1",
    KUMO_E2E: "1",
    KUMO_E2E_CLIENT: path.join(here, "fake-client.mjs"),
  });
  app = await electron.launch({ args: [appDir], cwd: appDir, env });
  page = await app.firstWindow();
}

const sceneFrame = (): Frame | undefined => page.frames().find((f) => f.url().startsWith("kumo-scene://"));

async function sendPrompt(text: string): Promise<void> {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-e2e-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kumo-e2e-ws-"));
  fs.writeFileSync(path.join(workspace, "README.md"), "# e2e\n");
  // The app opens the most recent project; register the test workspace as one.
  process.env.KUMO_HOME = home;
  const { registerProject } = await import(pathToFileURL(path.join(repoRoot, "src/data/sessions.js")).href);
  registerProject(workspace);
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  for (const dir of [home, workspace]) fs.rmSync(dir, { recursive: true, force: true });
});

test("opens the last project on an empty chat with the scene running", async () => {
  await expect(page.getByRole("heading", { name: "what should we build?" })).toBeVisible();
  await expect(page.locator('[data-part="sidebar"] .side-item.project')).toContainText(path.basename(workspace));
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.scene)).toBe("ready");
  const scene = page.locator('[data-part="scene"]');
  await expect(scene).toHaveAttribute("sandbox", "allow-scripts");
  await expect(scene).toHaveAttribute("src", "kumo-scene://scene/");
});

test("streams an answer, runs a worker and shows it in the Workers panel", async () => {
  const prompt = "please delegate a look around the workspace and list every file you can find in it";
  await sendPrompt(prompt);
  await expect(page.locator('[data-part="message-user"]')).toHaveText(prompt);
  const lead = page.locator('[data-part="message-lead"]').last();
  await expect(lead.locator("strong")).toHaveText("the workspace");
  await expect(lead.locator("pre code")).toContainText('console.log("done");');
  await expect(lead.locator('[data-part="tool-card"]')).toHaveAttribute("data-status", "done");
  await expect(lead.locator(".tool-name")).toHaveText("explore");
  const worker = page.locator('[data-part="worker-card"]');
  await expect(worker).toContainText("List the files in the workspace");
  await expect(worker).toContainText("e2e-worker");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // The turn's end refreshes the usage meters and names the chat after the
  // prompt; a long name is cut short instead of widening the sidebar.
  const sidebar = page.locator('[data-part="sidebar"]');
  await expect(sidebar).toContainText("75% left");
  await expect(sidebar.locator(".side-item.chat")).toContainText("please delegate");
  expect((await sidebar.boundingBox())?.width).toBe(248);
});

test("an approval card blocks the turn until it's approved, then the change lands", async () => {
  const marker = path.join(workspace, "approved.txt");
  await sendPrompt("approve the command");
  const card = page.locator('[data-part="approval"]');
  await expect(card).toContainText("Approval needed");
  await expect(card.locator(".diff")).toHaveText("echo approved > approved.txt");
  expect(fs.existsSync(marker)).toBe(false);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('[data-part="message-lead"]').last()).toContainText("Approved and written.");
  expect(fs.readFileSync(marker, "utf-8")).toBe("approved\n");
});

test("switches light and dark, the scene and the dock, and remembers them", async () => {
  await page.getByRole("button", { name: "Appearance" }).click();
  const menu = page.getByRole("dialog", { name: "Appearance" });
  await menu.getByRole("radio", { name: "Light" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe("light");
  await menu.getByRole("radio", { name: "Dark" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.mode)).toBe("dark");
  await menu.getByRole("radio", { name: "Night sky" }).click();
  await menu.getByRole("radio", { name: "Bottom" }).click();
  await expect(page.locator('[data-part="workers"]')).toHaveAttribute("data-dock", "bottom");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "desktop.json"), "utf-8"));
  expect(saved).toMatchObject({ mode: "dark", scene: "stars", dock: "bottom" });
});

test("the scene frame can't reach the window, the network or Node", async () => {
  const frame = sceneFrame();
  expect(frame).toBeTruthy();
  const probe = await frame!.evaluate(async () => {
    let parentDocument = "reachable";
    try {
      void window.parent.document.title;
    } catch {
      parentDocument = "blocked";
    }
    const network = await fetch("https://example.com/").then(
      () => "reachable",
      () => "blocked"
    );
    const g = globalThis as Record<string, unknown>;
    return { parentDocument, network, node: typeof g.process + "/" + typeof g.require, kumo: typeof g.kumo };
  });
  expect(probe).toEqual({ parentDocument: "blocked", network: "blocked", node: "undefined/undefined", kumo: "undefined" });
});

test("comes back after the engine crashes", async () => {
  const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics());
  const engine = metrics.find((m) => m.type === "Utility" && m.name === "Kumo engine");
  expect(engine).toBeTruthy();
  process.kill(engine!.pid);
  await expect(page.locator(".toast")).toContainText("engine restarted");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  await sendPrompt("still there?");
  await expect(page.locator('[data-part="message-lead"]').last()).toContainText('console.log("done");');
});
