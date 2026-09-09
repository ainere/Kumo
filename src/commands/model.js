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

export function effortCommand(target, value) {
  const config = loadConfig();

  // Handle kumo effort worker <level>
  if (target === "worker") {
    if (!value || value === "show" || value === "get") {
      console.log(`\n  ${c.dim}Current worker reasoning effort:${c.reset} ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
      console.log(`  ${c.dim}Available options:${c.reset} low, medium, high`);
      console.log(`  ${c.dim}Usage:${c.reset} kumo effort worker <low|medium|high>\n`);
      return;
    }
    const effortLevel = value.toLowerCase();
    const validEfforts = ["low", "medium", "high"];
    if (!validEfforts.includes(effortLevel)) {
      console.error(`${badge.fail} Invalid worker reasoning effort '${value}'. Supported levels: ${validEfforts.join(", ")}`);
      process.exit(1);
    }
    setConfigValue("workerEffort", effortLevel);
    console.log(`${badge.ok} Worker reasoning effort set to '${effortLevel}'`);
    return;
  }

  // Orchestrator effort
  const level = target;
  if (!level || level === "show" || level === "status" || level === "get") {
    console.log(`\n  ${c.dim}Current orchestrator reasoning effort:${c.reset} ${c.brightCyan}${config.reasoningEffort || "low"}${c.reset}`);
    console.log(`  ${c.dim}Current worker reasoning effort:${c.reset}       ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
    console.log(`  ${c.dim}Usage:${c.reset} kumo effort <low|medium|high|max>`);
    console.log(`         kumo effort worker <low|medium|high>\n`);
    return;
  }

  const effortLevel = level.toLowerCase();
  const validEfforts = ["low", "medium", "high", "max"];
  if (!validEfforts.includes(effortLevel)) {
    console.error(`${badge.fail} Invalid reasoning effort '${level}'. Supported levels: ${validEfforts.join(", ")}`);
    process.exit(1);
  }

  setConfigValue("reasoningEffort", effortLevel);
  console.log(`${badge.ok} Orchestrator reasoning effort set to '${effortLevel}'`);
}

export function modelCommand(action, target, value, extra) {
  const config = loadConfig();

  // If no action or 'show' / 'status', print current setup
  if (!action || action === "show" || action === "status" || action === "list") {
    console.log(`\n${c.bold}KUMO Model Configuration${c.reset}`);
    console.log(separator(50));
    console.log(`  ${c.dim}Orchestrator:${c.reset}      ${c.brightCyan}${config.orchestratorModel}${c.reset} (Provider: ${config.orchestratorProvider || 'codex'})`);
    console.log(`  ${c.dim}Reasoning:${c.reset}         ${config.reasoningEffort || 'low'}`);
    console.log(`  ${c.dim}Worker:${c.reset}            ${c.brightBlue}${config.workerModel}${c.reset} (Provider: ${config.workerProvider || 'gemini'})`);
    console.log(`  ${c.dim}Worker Reasoning:${c.reset}  ${config.workerEffort || 'medium'}`);
    console.log(`  ${c.dim}CLI Binary:${c.reset}        ${config.cliBinary || 'gemini'}`);

    console.log(`\n${c.bold}Available Presets:${c.reset}`);
    for (const [key, preset] of Object.entries(PRESETS)) {
      const isCurrent =
        config.orchestratorModel === preset.config.orchestratorModel &&
        config.workerModel === preset.config.workerModel &&
        config.reasoningEffort === preset.config.reasoningEffort &&
        config.workerEffort === preset.config.workerEffort;
      const marker = isCurrent ? `${c.brightGreen}* ${c.reset}` : "  ";
      console.log(`  ${marker}${c.bold}${key.padEnd(12)}${c.reset} ${badge.arrow} ${preset.name} (${preset.description})`);
    }

    console.log(`\n${c.bold}Commands:${c.reset}`);
    console.log(`  ${c.dim}kumo model <model>                       ${c.reset}  Set orchestrator model`);
    console.log(`  ${c.dim}kumo model orchestrator <model> [effort]${c.reset}  Set orchestrator model and effort`);
    console.log(`  ${c.dim}kumo model worker <model> [effort]       ${c.reset}  Set worker model and effort`);
    console.log(`  ${c.dim}kumo effort <low|medium|high|max>        ${c.reset}  Set orchestrator reasoning effort`);
    console.log(`  ${c.dim}kumo effort worker <low|medium|high>     ${c.reset}  Set worker reasoning effort`);
    console.log(`  ${c.dim}kumo model use <preset>                  ${c.reset}  Apply preset (e.g. kumo model use test)\n`);
    return;
  }

  // Handle effort delegation: kumo model effort <level> or kumo model reasoning <level>
  if (action === "effort" || action === "reasoning") {
    effortCommand(target);
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

  // Handle setting worker model: kumo model worker <model> [effort]
  if (action === "worker") {
    const model = target;
    const effort = value;
    if (!model) {
      console.log(`Current worker: ${config.workerModel} (reasoning: ${config.workerEffort || 'medium'})`);
      console.log("Usage: kumo model worker <model> [effort]");
      return;
    }
    setConfigValue("workerModel", model);
    if (effort) {
      setConfigValue("workerEffort", effort);
    }
    console.log(`${badge.ok} Worker model set to '${model}'${effort ? ` with reasoning effort '${effort}'` : ''}`);
    return;
  }

  // Fallback 1: custom positional syntax: kumo model <orchestrator> <worker> [effort]
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

  // Fallback 2: single model shorthand: kumo model <model>
  if (action && !target) {
    if (PRESETS[action]) {
      applyPreset(action);
      const updated = loadConfig();
      console.log(`${badge.ok} Applied preset '${action}':`);
      console.log(`  ${badge.dot} Orchestrator: ${updated.orchestratorModel} (effort: ${updated.reasoningEffort})`);
      console.log(`  ${badge.dot} Worker:       ${updated.workerModel}`);
      return;
    }

    setConfigValue("orchestratorModel", action);
    console.log(`${badge.ok} Orchestrator model set to '${action}'`);
    return;
  }

  console.error(`${badge.fail} Unknown model command. Run 'kumo model' for usage.`);
  process.exit(1);
}
