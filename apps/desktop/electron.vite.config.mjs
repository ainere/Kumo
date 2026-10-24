import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          // Runs in an Electron utilityProcess. It loads the engine (src/core)
          // from disk at runtime rather than bundling it: the provider clients
          // locate src/bridge/server.js relative to their own files.
          "engine-host": resolve("src/main/engine-host.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        input: { index: resolve("src/preload/index.ts") },
        // A sandboxed renderer only runs CommonJS preloads.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react()],
    build: { minify: true },
  },
});
