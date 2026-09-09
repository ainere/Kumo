/**
 * doctor.js — CLI command to diagnose environment and subscriptions.
 */

import { runDiagnostics } from "../utils/diagnostics.js";
import { getBanner, c, badge, separator } from "../utils/ui.js";

export async function doctorCommand() {
  console.log("\n" + getBanner());
  console.log(separator(64));
  console.log(`  ${c.bold}System & Subscription Diagnostics${c.reset}`);
  console.log(separator(64) + "\n");

  const results = await runDiagnostics();

  // Helper for check lines
  const printCheck = (label, res) => {
    const status = res.ok ? badge.ok : badge.fail;
    const padLabel = label.padEnd(26);
    console.log(`  ${status} ${padLabel} ${res.details}`);
  };

  printCheck("Node.js Runtime", results.node);
  printCheck("Codex CLI (OpenAI)", results.codex);
  printCheck("Gemini CLI (Google)", results.gemini);
  printCheck("MCP Bridge Server", results.bridge);

  console.log(`\n  ${c.dim}Global Config:${c.reset}  ${results.config.path}`);
  for (const [k, v] of Object.entries(results.config.values)) {
    console.log(`    ${badge.dot} ${k}: ${c.dim}${JSON.stringify(v)}${c.reset}`);
  }

  console.log("\n" + separator(64));
  if (results.node.ok && results.codex.ok && results.gemini.ok && results.bridge.ok) {
    console.log(`  ${badge.ok} ${c.brightGreen}All systems operational.${c.reset} Ready to run 'kumo'.`);
  } else {
    console.log(`  ${badge.warn} ${c.brightYellow}Action required for some components:${c.reset}`);
    if (!results.codex.ok) {
      console.log(`    ${badge.dot} Install Codex CLI: npm install -g @openai/codex && codex login`);
    }
    if (!results.gemini.ok) {
      console.log(`    ${badge.dot} Configure Gemini binary: kumo config set cliBinary gemini`);
    }
  }
  console.log(separator(64) + "\n");
}
