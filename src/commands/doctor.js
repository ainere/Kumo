/**
 * doctor.js — CLI command to diagnose environment and subscriptions.
 */

import { runDiagnostics, isEnvironmentReady } from "../utils/diagnostics.js";
import { getBanner, c, badge, separator } from "../utils/ui.js";
import { VERSION } from "../cli.js";

export async function doctorCommand() {
  const results = await runDiagnostics();
  const style = results.config.values.bannerStyle || "block";
  console.log("\n" + getBanner(VERSION, style));
  console.log(separator(64));
  console.log(`  ${c.bold}System & Subscription Diagnostics${c.reset}`);
  console.log(separator(64) + "\n");

  // Helper for check lines
  const printCheck = (label, res) => {
    const status = res.ok ? badge.ok : badge.fail;
    const padLabel = label.padEnd(26);
    console.log(`  ${status} ${padLabel} ${res.details}`);
  };

  printCheck("Node.js Runtime", results.node);
  printCheck("Codex CLI (OpenAI)", results.codex);
  printCheck("Gemini CLI (Google)", results.gemini);
  printCheck("Copilot CLI (GitHub)", results.copilot || { ok: false, details: "missing" });
  printCheck("Cursor Agent", results.cursor || { ok: false, details: "missing" });
  printCheck("Gemini CLI (standalone)", results.geminiCli || { ok: false, details: "missing" });
  printCheck("Ollama Local", results.ollama || { ok: false, details: "missing" });
  printCheck("OpenAI API (env)", results.openaiApi || { ok: false, details: "missing" });
  printCheck("Anthropic API (env)", results.anthropicApi || { ok: false, details: "missing" });
  printCheck("Gemini API (env)", results.geminiApi || { ok: false, details: "missing" });
  printCheck("Compat API (env)", results.compatApi || { ok: false, details: "missing" });
  printCheck("MCP Bridge Server", results.bridge);
  printCheck("Orchestrator Path", results.orchestratorPath || { ok: false, details: "missing" });
  printCheck("Worker Path", results.workerPath || { ok: false, details: "missing" });

  console.log(`\n  ${c.dim}Global Config:${c.reset}  ${results.config.path}`);
  for (const [k, v] of Object.entries(results.config.values)) {
    console.log(`    ${badge.dot} ${k}: ${c.dim}${JSON.stringify(v)}${c.reset}`);
  }

  console.log("\n" + separator(64));
  const ready = isEnvironmentReady(results);

  if (ready) {
    console.log(`  ${badge.ok} ${c.brightGreen}All systems operational.${c.reset} Ready to run 'kumo'.`);
  } else {
    process.exitCode = 1;
    console.log(`  ${badge.warn} ${c.brightYellow}Action required for some components:${c.reset}`);
    if (!results.codex.ok && !results.openaiApi?.ok) {
      console.log(`    ${badge.dot} Install Codex CLI: npm install -g @openai/codex && codex login (or set OPENAI_API_KEY)`);
    }
    if (!results.gemini.ok && !results.geminiApi?.ok && !results.anthropicApi?.ok) {
      console.log(`    ${badge.dot} Configure Gemini binary: kumo config set cliBinary gemini (or set a Direct API key)`);
    }
    if (!results.orchestratorPath?.ok) {
      console.log(`    ${badge.dot} No orchestrator path: log in to a subscription CLI or set a Direct API key`);
    }
    if (!results.workerPath?.ok) {
      console.log(`    ${badge.dot} No worker path: install a worker CLI (gemini, claude, gh copilot, cursor-agent, ollama) or set a Direct API key`);
    }
  }
  console.log(separator(64) + "\n");
}
