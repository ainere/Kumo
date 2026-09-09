/**
 * model.js — CLI command to inspect and switch models for Orchestrator and Worker.
 * Supports arbitrary model strings to keep Kumo completely open-ended.
 */

import {
  loadConfig,
  setConfigValue,
  applyPreset,
  PRESETS,
} from "../config/settings.js";

export function modelCommand(action, target, value, extra) {
  const config = loadConfig();

  // If no action or 'show' / 'status', print current setup
  if (!action || action === "show" || action === "status" || action === "list") {
    console.log("\n🕸️  Kumo (雲) Model Configuration\n");
    console.log(`  🧠 Orchestrator:  ${config.orchestratorModel} (Provider: ${config.orchestratorProvider || 'codex'})`);
    console.log(`     Reasoning:     ${config.reasoningEffort || 'low'}`);
    console.log(`  ⚡ Worker:        ${config.workerModel} (Provider: ${config.workerProvider || 'gemini'})`);
    console.log(`     CLI Binary:    ${config.cliBinary || 'gemini'}`);

    console.log("\n📦 Available Presets:");
    for (const [key, preset] of Object.entries(PRESETS)) {
      const isCurrent =
        config.orchestratorModel === preset.config.orchestratorModel &&
        config.workerModel === preset.config.workerModel &&
        config.reasoningEffort === preset.config.reasoningEffort;
      const marker = isCurrent ? "★ " : "  ";
      console.log(`  ${marker}${key.padEnd(12)} : ${preset.name} (${preset.description})`);
    }

    console.log("\n💡 Quick Switch Commands:");
    console.log("  kumo model orchestrator <model> [effort]  # Set orchestrator model");
    console.log("  kumo model worker <model>                 # Set worker model");
    console.log("  kumo model use <preset>                   # Apply a preset (e.g. kumo model use pro)\n");
    return;
  }

  // Handle preset application: kumo model use <preset> or kumo model preset <preset>
  if (action === "use" || action === "preset") {
    const presetName = target;
    if (!presetName) {
      console.log("Available presets:", Object.keys(PRESETS).join(", "));
      return;
    }
    try {
      applyPreset(presetName);
      const updated = loadConfig();
      console.log(`✓ Applied preset '${presetName}':`);
      console.log(`  • Orchestrator: ${updated.orchestratorModel} (effort: ${updated.reasoningEffort})`);
      console.log(`  • Worker:       ${updated.workerModel}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Direct switch: kumo model orchestrator <model> [effort]
  if (action === "orchestrator") {
    const model = target;
    const effort = value;
    if (!model) {
      console.error("Error: Please provide a model name. Example: kumo model orchestrator chatgpt-6-astra low");
      process.exit(1);
    }
    setConfigValue("orchestratorModel", model);
    if (effort) {
      setConfigValue("reasoningEffort", effort);
    }
    console.log(`✓ Orchestrator model set to '${model}'${effort ? ` with reasoning effort '${effort}'` : ''}`);
    return;
  }

  // Direct switch: kumo model worker <model>
  if (action === "worker") {
    const model = target;
    if (!model) {
      console.error("Error: Please provide a model name. Example: kumo model worker gemini-3.8-flash");
      process.exit(1);
    }
    setConfigValue("workerModel", model);
    console.log(`✓ Worker model set to '${model}'`);
    return;
  }

  // Generic setter: kumo model set <orchestrator|worker> <model> [effort]
  if (action === "set") {
    const role = target?.toLowerCase();
    const model = value;
    const effort = extra;

    if (role === "orchestrator") {
      if (!model) {
        console.error("Error: Model name required. Example: kumo model set orchestrator chatgpt-6-astra");
        process.exit(1);
      }
      setConfigValue("orchestratorModel", model);
      if (effort) setConfigValue("reasoningEffort", effort);
      console.log(`✓ Orchestrator model set to '${model}'${effort ? ` (effort: ${effort})` : ''}`);
      return;
    } else if (role === "worker") {
      if (!model) {
        console.error("Error: Model name required. Example: kumo model set worker gemini-3.8-flash");
        process.exit(1);
      }
      setConfigValue("workerModel", model);
      console.log(`✓ Worker model set to '${model}'`);
      return;
    } else {
      console.error("Error: Target must be 'orchestrator' or 'worker'. Example: kumo model set worker gemini-3.8-flash");
      process.exit(1);
    }
  }

  console.error(`Error: Unknown action '${action}'. Run 'kumo model' to view options.`);
  process.exit(1);
}
