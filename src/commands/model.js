/**
 * model.js — CLI command to inspect and switch models for Orchestrator and Worker.
 * Supports arbitrary model strings to keep Kumo completely open-ended.
 */

import {
  loadConfig,
  setConfigValue,
  applyPreset,
  presetMatches,
  PRESETS,
  resolveModel,
  detectProviderForModel,
} from "../config/settings.js";
import { c, badge, separator } from "../utils/ui.js";
import { openInteractiveModelPicker, SUBSCRIPTION_PROVIDERS, DIRECT_API_PROVIDERS } from "../utils/model-picker.js";
import { MODEL_CATALOG, planLabel, EFFORT_LEVELS } from "../config/models.js";

export function effortCommand(target, value) {
  const config = loadConfig();

  // Handle kumo effort worker <level>
  if (target === "worker") {
    if (!value || value === "show" || value === "get") {
      console.log(`\n  ${c.gray}Current worker reasoning effort:${c.reset} ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
      console.log(`  ${c.gray}Available options:${c.reset} ${EFFORT_LEVELS.join(", ")}`);
      console.log(`  ${c.gray}Usage:${c.reset} kumo effort worker <${EFFORT_LEVELS.join("|")}>\n`);
      return;
    }
    const effortLevel = value.toLowerCase();
    const validEfforts = EFFORT_LEVELS;
    if (!validEfforts.includes(effortLevel)) {
      console.error(`${badge.fail} Invalid worker reasoning effort '${value}'. Supported levels: ${validEfforts.join(", ")}`);
      process.exit(1);
    }
    setConfigValue("workerEffort", effortLevel);
    console.log(`${badge.ok} Worker reasoning effort set to '${effortLevel}'`);
    return;
  }

  // Handle kumo effort orchestrator <level>, symmetric with the worker form.
  if (target === "orchestrator" && (!value || value === "show" || value === "get")) {
    console.log(`\n  ${c.gray}Current orchestrator reasoning effort:${c.reset} ${c.brightCyan}${config.reasoningEffort || "low"}${c.reset}`);
    console.log(`  ${c.gray}Available options:${c.reset} ${EFFORT_LEVELS.join(", ")}`);
    console.log(`  ${c.gray}Usage:${c.reset} kumo effort orchestrator <${EFFORT_LEVELS.join("|")}>\n`);
    return;
  }

  // Orchestrator effort
  const level = target === "orchestrator" ? value : target;
  if (!level || level === "show" || level === "status" || level === "get") {
    console.log(`\n  ${c.gray}Current orchestrator reasoning effort:${c.reset} ${c.brightCyan}${config.reasoningEffort || "low"}${c.reset}`);
    console.log(`  ${c.gray}Current worker reasoning effort:${c.reset}       ${c.brightBlue}${config.workerEffort || "medium"}${c.reset}`);
    console.log(`  ${c.gray}Usage:${c.reset} kumo effort <${EFFORT_LEVELS.join("|")}>`);
    console.log(`         kumo effort worker <${EFFORT_LEVELS.join("|")}>\n`);
    return;
  }

  const effortLevel = level.toLowerCase();
  const validEfforts = EFFORT_LEVELS;
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
    if (action) {
      // Without a TTY there is no picker. Falling through would treat the
      // literal word "select" as a model name and persist it.
      printModelList(config);
      return;
    }
  }

  // If 'list' or non-interactive 'show' / 'status', print comprehensive model & preset list
  if (!action || action === "show" || action === "status" || action === "list") {
    printModelList(config);
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
    const model = resolveModel(raw);
    const provider = detectProviderForModel(model, customProvider);
    if (effort && !EFFORT_LEVELS.includes(String(effort).toLowerCase())) {
      console.error(`${badge.fail} Invalid orchestrator effort '${effort}'. Allowed: ${EFFORT_LEVELS.join(", ")}`);
      process.exit(1);
    }
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
    const model = resolveModel(raw);
    const provider = detectProviderForModel(model, customProvider);
    if (effort && !EFFORT_LEVELS.includes(String(effort).toLowerCase())) {
      console.error(`${badge.fail} Invalid worker effort '${effort}'. Allowed: ${EFFORT_LEVELS.join(", ")}`);
      process.exit(1);
    }
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
    const model = resolveModel(action);
    const worker = resolveModel(target);
    const effort = value;
    const orchProvider = detectProviderForModel(model);
    const workerProvider = detectProviderForModel(worker);
    setConfigValue("orchestratorModel", model);
    setConfigValue("orchestratorProvider", orchProvider);
    setConfigValue("workerModel", worker);
    setConfigValue("workerProvider", workerProvider);
    if (effort && !EFFORT_LEVELS.includes(String(effort).toLowerCase())) {
      console.error(`${badge.fail} Invalid orchestrator effort '${effort}'. Allowed: ${EFFORT_LEVELS.join(", ")}`);
      process.exit(1);
    }
    if (effort) {
      setConfigValue("reasoningEffort", effort);
    }
    const finalEffort = effort || config.reasoningEffort || "low";
    console.log(`${badge.ok} Orchestrator model set to '${model}-${finalEffort}' (provider: ${orchProvider})`);
    console.log(`${badge.ok} Worker model set to '${worker}' (provider: ${workerProvider}). Worker effort unchanged (${config.workerEffort || 'medium'})`);
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
    const model = resolveModel(action);
    const provider = detectProviderForModel(model);
    setConfigValue("orchestratorModel", model);
    setConfigValue("orchestratorProvider", provider);
    console.log(`${badge.ok} Orchestrator model set to '${model}-${config.reasoningEffort || 'low'}' (provider: ${provider})`);
    return;
  }

  console.error(`${badge.fail} Unknown model command. Run 'kumo model' for usage.`);
  process.exit(1);
}


/**
 * Print the full inventory of presets, orchestrator models, worker models,
 * and provider families. Shared by `kumo model list` and by the non-TTY
 * fallback for `kumo model select`.
 *
 * @param {object} config
 */
function printModelList(config) {
  console.log(`\n${c.bold}${c.brightCyan}KUMO Model Configuration & Available Models${c.reset}`);
  console.log(separator(60));
  const orchModelFull = config.reasoningEffort ? `${config.orchestratorModel}-${config.reasoningEffort}` : config.orchestratorModel;
  const workerModelFull = config.workerEffort ? `${config.workerModel}-${config.workerEffort}` : config.workerModel;
  console.log(`  ${c.gray}Orchestrator:${c.reset}      ${c.brightCyan}${orchModelFull}${c.reset} (${config.orchestratorProvider}, ${planLabel(config.orchestratorProvider, config.orchestratorModel)})`);
  console.log(`  ${c.gray}Worker:${c.reset}            ${c.brightBlue}${workerModelFull}${c.reset} (${config.workerProvider}, ${planLabel(config.workerProvider, config.workerModel)})`);
  console.log(`  ${c.gray}CLI Binary:${c.reset}        ${config.cliBinary || 'agy'}`);

  console.log(`\n${c.bold}Available Presets:${c.reset}`);
  for (const [key, preset] of Object.entries(PRESETS)) {
    const isCurrent = presetMatches(key, config);
    const marker = isCurrent ? `${c.brightGreen}* ${c.reset}` : "  ";
    console.log(`  ${marker}${c.bold}${key.padEnd(12)}${c.reset} ${badge.arrow} ${preset.name}`);
    console.log(`     ${c.skyBlue}${preset.description}${c.reset}`);
  }

  console.log(`\n${c.bold}Subscription CLIs:${c.reset} ${c.gray}(${SUBSCRIPTION_PROVIDERS.join(", ")})${c.reset}`);
  // Any model works in either role; the lists are grouped by the CLI that runs them.
  const groups = [
    ["codex", "Codex (ChatGPT subscription)"],
    ["claude", "Claude Code (Claude subscription)"],
    ["antigravity", "Antigravity (Google AI Pro)"],
  ];
  for (const [provider, title] of groups) {
    console.log(`\n${c.bold}${title}:${c.reset} ${c.gray}provider ${provider}${c.reset}`);
    for (const m of MODEL_CATALOG[provider]) {
      const isCurrent =
        (config.orchestratorProvider === provider && config.orchestratorModel === m.id) ||
        (config.workerProvider === provider && config.workerModel === m.id);
      const marker = isCurrent ? `${c.brightGreen}* ${c.reset}` : "  ";
      const alias = m.alias ? ` ${c.gray}(${m.alias})${c.reset}` : "";
      console.log(`  ${marker}${c.brightCyan}${m.id.padEnd(20)}${c.reset} ${m.name}${alias}${m.desc ? ` ${c.gray}— ${m.desc}${c.reset}` : ""}`);
    }
  }

  console.log(`\n${c.bold}Direct API:${c.reset} ${c.gray}(${DIRECT_API_PROVIDERS.join(", ")} — env keys, never stored)${c.reset}`);
  console.log(`  ${c.gray}Set an explicit provider per call, e.g.:${c.reset}`);
  console.log(`  ${c.gray}kumo model worker gpt-4o-mini low anthropic-api${c.reset}`);
  console.log(`  ${c.gray}Keys live only in env: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, COMPAT_API_KEY (optional) + COMPAT_BASE_URL.${c.reset}`);

  console.log(`\n${c.bold}Commands & Arrow Navigation:${c.reset}`);
  console.log(`  ${c.gray}kumo model${c.reset}                                            Launch interactive arrow-key selector`);
  console.log(`  ${c.gray}kumo model <model>${c.reset}                                    Set orchestrator model`);
  console.log(`  ${c.gray}kumo model orchestrator <model> [effort] [provider]${c.reset}  Set orchestrator model, effort, and explicit provider`);
  console.log(`  ${c.gray}kumo model worker <model> [effort] [provider]${c.reset}        Set worker model, effort, and explicit provider`);
  console.log(`  ${c.gray}kumo effort <${EFFORT_LEVELS.join("|")}>${c.reset}                      Set orchestrator reasoning effort`);
  console.log(`  ${c.gray}kumo effort worker <${EFFORT_LEVELS.join("|")}>${c.reset}                   Set worker reasoning effort`);
  console.log(`  ${c.gray}kumo model use <preset>${c.reset}                                Apply preset (e.g. kumo model use test)`);
  console.log(`  ${c.gray}kumo role${c.reset}                                              Show or set the model each role runs on\n`);
}