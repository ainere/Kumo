import { defineConfig } from "@playwright/test";

// Electron end-to-end tests. They launch the built app (npm run test:e2e
// builds first) against a scripted orchestrator, so no provider is needed.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  outputDir: "../../test-results/desktop",
});
