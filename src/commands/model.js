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
import { c, badge, separator } from "../utils/ui.js";

export function modelCommand(action, target, value, extra) {
  const config = loadConfig();

  // If no action or 'show' / 'status', print current setup
  if (!action || action === "show" || action === "status" || action === "list") {
    console.log(`\n${c.bold}KUMO Model Configuration${c.reset}`);
    console.log(separator(50));
    console.log(`  ${c.dim}Orchestrator:${c.reset}  ${c.brightCyan}${config.orchestratorModel}${c.reset} (Provider: ${config.orchestratorProvider || 'codex'})`);
    console.log(`  ${c.dim}Reasoning:${c.reset}     ${config.reasoningEffort || 'low'}`);
    console.log(`  ${c.dim}Worker:${c.reset}        ${c.brightBlue}${config.workerModel}${c.reset} (Provider: ${config.workerProvider || 'gemini'})`);
    console.log(`  ${c.dim}CLI Binary:${c.reset}    ${config.cliBinary || 'gemini'}`);

    console.log(`\n${c.bold}Available Presets:${c.reset}`);
    for (const [key, preset] of Object.entries(PRESETS)) {
      const isCurrent =
        config.orchestratorModel === preset.config.orchestratorModel &&
        config.workerModel === preset.config.workerModel &&
        config.reasoningEffort === preset.config.reasoningEffort;
      const marker = isCurrent ? `${c.brightGreen}* ${c.reset}` : "  ";
      console.log(`  ${marker}${c.bold}${key.padEnd(10)}${c.reset} ${badge.arrow} ${preset.name} (${preset.description})`);
    }

    console.log(`\n${c.bold}Commands:${c.reset}`);
    console.log(`  ${c.dim}kumo model orchestrator <model> [effort]${c.reset}  Set orchestrator model`);
    console.log(`  ${c.dim}kumo model worker <model>                ${c.reset}  Set worker model`);
    console.log(`  ${c.dim}kumo model use <preset>                  ${c.reset}  Apply preset (e.g. kumo model use pro)\n`);
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
      console.log(`${badge.ok} Applied preset '${presetName}':`);
      console.log(`  ${badge.dot} Orchestrator: ${updated.orchestratorModel} (effort: ${updated.reasoningEffort})`);
      console.log(`  ${badge.dot} Worker:       ${updated.workerModel}`);
    } catch (err) {
      console.error(`${badge.fail} ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Handle setting orchestrator model: kumo model orchestrator <model> [effort]
  if (action === "orchestrator") {
    const model = target;
    const effort = value;
    if (!model) {
      console.log(`Current orchestrator: ${config.orchestratorModel} (effort: ${config.reasoningEffort})`);
      console.log("Usage: kumo model orchestrator <model> [effort]");
      return;
    }
    setConfigValue("orchestratorModel", model);
    if (effort) {
      setConfigValue("reasoningEffort", effort);
    }
    console.log(`${badge.ok} Orchestrator model set to '${model}'${effort ? ` with reasoning effort '${effort}'` : ''}`);
    return;
  }

  // Handle setting worker model: kumo model worker <model>
  if (action === "worker") {
    const model = target;
    if (!model) {
      console.log(`Current worker: ${config.workerModel}`);
      console.log("Usage: kumo model worker <model>");
      return;
    }
    setConfigValue("workerModel", model);
    console.log(`${badge.ok} Worker model set to '${model}'`);
    return;
  }

  // Fallback: custom positional syntax: kumo model <orchestrator> <worker> [effort]
  if (action && target) {
    const model = action;
    const worker = target;
    const effort = value;
    setConfigValue("orchestratorModel", model);
    setConfigValue("workerModel", worker);
    if (effort) {
      setConfigValue("reasoningEffort", effort);
    }
    console.log(`${badge.ok} Orchestrator model set to '${model}'${effort ? ` (effort: ${effort})` : ''}`);
    console.log(`${badge.ok} Worker model set to '${worker}'`);
    return;
  }

  console.error(`${badge.fail} Unknown model command. Run 'kumo model' for usage.`);
  process.exit(1);
}
