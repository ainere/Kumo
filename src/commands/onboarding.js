/**
 * onboarding.js — First-run guided setup for Kumo.
 * Runs diagnostics inline, lets user pick a preset, and drops to REPL.
 */

import { runDiagnostics } from "../utils/diagnostics.js";
import { PRESETS, applyPreset } from "../config/settings.js";
import { promptSelect } from "../utils/model-picker.js";
import { c, badge, separator, getBanner } from "../utils/ui.js";
import { VERSION } from "../cli.js";

export async function runOnboarding() {
  console.log("\n" + getBanner(VERSION, "cloud"));
  console.log(separator(64));
  console.log(`  ${c.bold}${c.brightCyan}Welcome to KUMO (雲)${c.reset} — Cross-Provider AI Orchestrator\n`);
  console.log(`  ${c.dim}First-time setup — checking your environment:${c.reset}\n`);

  const results = await runDiagnostics();

  const checks = [
    { label: "Node.js Runtime", result: results.node },
    { label: "Codex CLI (OpenAI)", result: results.codex },
    { label: "Antigravity CLI (Google)", result: results.gemini },
    { label: "MCP Bridge Server", result: results.bridge },
  ];

  for (const check of checks) {
    const icon = check.result.ok ? badge.ok : badge.fail;
    console.log(`    ${icon} ${check.label.padEnd(28)} ${c.dim}${check.result.details}${c.reset}`);
  }

  console.log("");

  if (!results.codex.ok || !results.gemini.ok) {
    console.log(`  ${badge.warn} Some components need attention. Run ${c.cyan}kumo doctor${c.reset} for details.\n`);
  }

  // Preset selection
  const presetItems = Object.entries(PRESETS).map(([key, p]) => ({
    label: p.name,
    value: key,
    hint: p.description,
  }));

  const chosen = await promptSelect({
    title: "Select Starting Configuration",
    items: presetItems,
    initialIndex: 0,
  });

  if (chosen) {
    applyPreset(chosen);
    console.log(`  ${badge.ok} Applied preset '${chosen}'.\n`);
  }

  console.log(`  ${c.dim}Setup complete. You can change models anytime with /model.${c.reset}`);
  console.log(separator(64) + "\n");
}
