import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "graphify-out/",
      "scratch/",
      "coverage/",
      "src/core/vendor/",
      "apps/desktop/out/",
      "test-results/",
      "playwright-report/",
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Unused parameters document a callback's shape; unused caught errors
      // are the norm for best-effort cleanup.
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Background scenes: classic browser scripts run inside the scene iframe.
    files: ["apps/desktop/src/main/scenes/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, defineScene: "readonly" },
    },
  },
];
