/**
 * doctor.js — CLI command to diagnose environment and subscriptions.
 */

import { runDiagnostics } from "../utils/diagnostics.js";

export async function doctorCommand() {
  console.log("\n🔍 Running Kumo (雲) Cross-Provider Diagnostics...\n");

  const results = await runDiagnostics();

  // Node.js
  if (results.node.ok) {
    console.log(`  ✅ Node.js:               ${results.node.details}`);
  } else {
    console.log(`  ❌ Node.js:               ${results.node.details}`);
  }

  // Codex CLI
  if (results.codex.ok) {
    console.log(`  ✅ Codex CLI (OpenAI):    ${results.codex.details}`);
  } else {
    console.log(`  ❌ Codex CLI (OpenAI):    ${results.codex.details}`);
  }

  // Antigravity / Gemini CLI
  if (results.gemini.ok) {
    console.log(`  ✅ Gemini CLI (Google):   ${results.gemini.details}`);
  } else {
    console.log(`  ❌ Gemini CLI (Google):   ${results.gemini.details}`);
  }

  // MCP Bridge
  if (results.bridge.ok) {
    console.log(`  ✅ MCP Bridge Server:     ${results.bridge.details}`);
  } else {
    console.log(`  ❌ MCP Bridge Server:     ${results.bridge.details}`);
  }

  console.log(`\n📁 Global Config File:      ${results.config.path}`);
  console.log("   Current Settings:");
  for (const [k, v] of Object.entries(results.config.values)) {
    console.log(`     • ${k}: ${JSON.stringify(v)}`);
  }

  console.log("\n" + "─".repeat(60));
  if (results.node.ok && results.codex.ok && results.gemini.ok && results.bridge.ok) {
    console.log("✨ All systems operational! Run 'kumo' in any project to start.");
  } else {
    console.log("⚠️ Some components require attention. Review the issues above.");
    if (!results.codex.ok) {
      console.log("   • To install Codex: npm install -g @openai/codex && codex login");
    }
    if (!results.gemini.ok) {
      console.log("   • To configure Gemini binary: kumo config set cliBinary gemini");
    }
  }
  console.log("");
}
