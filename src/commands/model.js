/**
 * model.js — CLI command to inspect and switch models for Orchestrator and Worker.
 * Supports arbitrary model strings to keep Kumo completely open-ended.
 */

import {
  loadConfig,
  setConfigValue,
  applyPreset,
  PRESETS,
  resolveOrchestratorModel,
  resolveWorkerModel,
  detectProviderForModel,
  isCodexModel,
} from "../config/settings.js";
import { c, badge, separator } from "../utils/ui.js";
import { openInteractiveModelPicker, DEFAULT_CODEX_MODELS } from "../utils/model-picker.js";
import { DEFAULT_WORKER_MODELS } from "../bridge/agy-runner.js";

export function effortCommand(target, value) {
  const config = loadConfig();

  // Handle kumo effort worker <level>
  if (target === "worker") {
    if (!value || value === "show" || value === "get") {
      console.log(`\n  ${c.gray}Current worker reasoning effort:${c.reset} ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
      console.log(`  ${c.gray}Available options:${c.reset} low, medium, high`);
      console.log(`  ${c.gray}Usage:${c.reset} kumo effort worker <low|medium|high>\n`);
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
    console.log(`\n  ${c.gray}Current orchestrator reasoning effort:${c.reset} ${c.brightCyan}${config.reasoningEffort || "low"}${c.reset}`);
    console.log(`  ${c.gray}Current worker reasoning effort:${c.reset}       ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
    console.log(`  ${c.gray}Usage:${c.reset} kumo effort <low|medium|high|max>`);
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

export async function modelCommand(action, target, value, extra) {
  const config = loadConfig();

  // If no action or 'select' in interactive terminal, open arrow-key navigator
  if (!action || action === "select" || action === "picker" || action === "menu") {
    if (process.stdout.isTTY && process.stdin.isTTY && !process.env.CI) {
      await openInteractiveModelPicker();
      return;
    }
  }

  // If 'list' or non-interactive 'show' / 'status', print comprehensive model & preset list
  if (!action || action === "show" || action === "status" || action === "list") {
    console.log(`\n${c.bold}${c.brightCyan}KUMO Model Configuration & Available Models${c.reset}`);
    console.log(separator(60));
    const orchModelFull = config.reasoningEffort ? `${config.orchestratorModel}-${config.reasoningEffort}` : config.orchestratorModel;
    const workerModelFull = config.workerEffort ? `${config.workerModel}-${config.workerEffort}` : config.workerModel;
    console.log(`  ${c.gray}Orchestrator:${c.reset}      ${c.brightCyan}${orchModelFull}${c.reset} (${config.orchestratorProvider === 'codex' ? 'ChatGPT Plus' : config.orchestratorProvider})`);
    console.log(`  ${c.gray}Worker:${c.reset}            ${c.brightBlue}${workerModelFull}${c.reset} (${config.workerProvider === 'gemini' ? 'Google AI Pro' : config.workerProvider})`);
    console.log(`  ${c.gray}CLI Binary:${c.reset}        ${config.cliBinary || 'gemini'}`);

    console.log(`\n${c.bold}Available Presets:${c.reset}`);
    for (const [key, preset] of Object.entries(PRESETS)) {
      const isCurrent =
        config.orchestratorModel === preset.config.orchestratorModel &&
        config.workerModel === preset.config.workerModel &&
        config.reasoningEffort === preset.config.reasoningEffort &&
        config.workerEffort === preset.config.workerEffort;
      const marker = isCurrent ? `${c.brightGreen}* ${c.reset}` : "  ";
      console.log(`  ${marker}${c.bold}${key.padEnd(12)}${c.reset} ${badge.arrow} ${preset.name}`);
      console.log(`     ${c.skyBlue}${preset.description}${c.reset}`);
    }

    console.log(`\n${c.bold}Available Orchestrator Models (Codex):${c.reset}`);
    for (const m of DEFAULT_CODEX_MODELS) {
      const isCurrent = config.orchestratorModel === m.id;
      const marker = isCurrent ? `${c.brightGreen}* ${c.reset}` : "  ";
      console.log(`  ${marker}${c.brightCyan}${m.id.padEnd(20)}${c.reset} ${m.name} ${c.gray}— ${m.desc}${c.reset}`);
    }

    console.log(`\n${c.bold}Available Worker Models (Antigravity):${c.reset}`);
    for (const m of DEFAULT_WORKER_MODELS) {
      const isCurrent = config.workerModel === m.id;
      const marker = isCurrent ? `${c.brightGreen}* ${c.reset}` : "  ";
      console.log(`  ${marker}${c.brightBlue}${m.id.padEnd(25)}${c.reset} ${m.name}${c.reset}`);
    }

    console.log(`\n${c.bold}Commands & Arrow Navigation:${c.reset}`);
    console.log(`  ${c.gray}kumo model${c.reset}                               Launch interactive arrow-key selector`);
    console.log(`  ${c.gray}kumo model <model>${c.reset}                       Set orchestrator model`);
    console.log(`  ${c.gray}kumo model orchestrator <model> [effort]${c.reset}  Set orchestrator model and effort`);
    console.log(`  ${c.gray}kumo model worker <model> [effort]${c.reset}        Set worker model and effort`);
    console.log(`  ${c.gray}kumo effort <low|medium|high|max>${c.reset}         Set orchestrator reasoning effort`);
    console.log(`  ${c.gray}kumo effort worker <low|medium|high>${c.reset}      Set worker reasoning effort`);
    console.log(`  ${c.gray}kumo model use <preset>${c.reset}                   Apply preset (e.g. kumo model use test)\n`);
    return;
  }

  // Handle effort delegation: kumo model effort <level> or kumo model reasoning <level>
  if (action === "effort" || action === "reasoning") {
    effortCommand(target, value);
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
      console.log(`  ${badge.dot} Orchestrator: ${updated.orchestratorModel}-${updated.reasoningEffort}`);
      console.log(`  ${badge.dot} Worker:       ${updated.workerModel}-${updated.workerEffort || 'medium'}`);
    } catch (err) {
      console.error(`${badge.fail} ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Handle setting orchestrator model: kumo model orchestrator <model> [effort] [provider]
  if (action === "orchestrator") {
    const raw = target;
    const effort = value;
    const customProvider = extra;
    if (!raw) {
      console.log(`Current orchestrator: ${config.orchestratorModel}-${config.reasoningEffort} [${config.orchestratorProvider || 'codex'}]`);
      console.log("Usage: kumo model orchestrator <model> [effort] [provider]");
      return;
    }
    const model = resolveOrchestratorModel(raw);
    const provider = detectProviderForModel(model, customProvider);
    setConfigValue("orchestratorModel", model);
    setConfigValue("orchestratorProvider", provider);
    if (effort) {
      setConfigValue("reasoningEffort", effort);
    }
    const finalEffort = effort || config.reasoningEffort || "low";
    console.log(`${badge.ok} Orchestrator model set to '${model}-${finalEffort}' (provider: ${provider})`);
    return;
  }

  // Handle setting worker model: kumo model worker <model> [effort] [provider]
  if (action === "worker") {
    const raw = target;
    const effort = value;
    const customProvider = extra;
    if (!raw) {
      console.log(`Current worker: ${config.workerModel}-${config.workerEffort || 'medium'} [${config.workerProvider || 'gemini'}]`);
      console.log("Usage: kumo model worker <model> [effort] [provider]");
      return;
    }
    const model = resolveWorkerModel(raw);
    const provider = detectProviderForModel(model, customProvider);
    setConfigValue("workerModel", model);
    setConfigValue("workerProvider", provider);
    if (effort) {
      setConfigValue("workerEffort", effort);
    }
    const finalEffort = effort || config.workerEffort || "medium";
    console.log(`${badge.ok} Worker model set to '${model}-${finalEffort}' (provider: ${provider})`);
    return;
  }

  // Fallback 1: custom positional syntax: kumo model <orchestrator> <worker> [effort]
  if (action && target) {
    const model = resolveOrchestratorModel(action);
    const worker = resolveWorkerModel(target);
    const effort = value;
    const orchProvider = detectProviderForModel(model);
    const workerProvider = detectProviderForModel(worker);
    setConfigValue("orchestratorModel", model);
    setConfigValue("orchestratorProvider", orchProvider);
    setConfigValue("workerModel", worker);
    setConfigValue("workerProvider", workerProvider);
    if (effort) {
      setConfigValue("reasoningEffort", effort);
    }
    const finalEffort = effort || config.reasoningEffort || "low";
    console.log(`${badge.ok} Orchestrator model set to '${model}-${finalEffort}' (provider: ${orchProvider})`);
    console.log(`${badge.ok} Worker model set to '${worker}-${config.workerEffort || 'medium'}' (provider: ${workerProvider})`);
    return;
  }

  // Fallback 2: single model shorthand: kumo model <model>
  if (action && !target) {
    if (PRESETS[action]) {
      applyPreset(action);
      const updated = loadConfig();
      console.log(`${badge.ok} Applied preset '${action}':`);
      console.log(`  ${badge.dot} Orchestrator: ${updated.orchestratorModel}-${updated.reasoningEffort} [${updated.orchestratorProvider}]`);
      console.log(`  ${badge.dot} Worker:       ${updated.workerModel}-${updated.workerEffort || 'medium'} [${updated.workerProvider}]`);
      return;
    }
    const model = resolveOrchestratorModel(action);
    const provider = detectProviderForModel(model);
    setConfigValue("orchestratorModel", model);
    setConfigValue("orchestratorProvider", provider);
    console.log(`${badge.ok} Orchestrator model set to '${model}-${config.reasoningEffort || 'low'}' (provider: ${provider})`);
    return;
  }

  console.error(`${badge.fail} Unknown model command. Run 'kumo model' for usage.`);
  process.exit(1);
}
