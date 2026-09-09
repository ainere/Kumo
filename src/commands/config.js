/**
 * config.js — CLI command to manage settings (~/.orchestrator/config.json).
 */

import {
  loadConfig,
  setConfigValue,
  resetConfig,
  getConfigPath,
} from "../config/settings.js";

export function configCommand(action, key, value) {
  const configPath = getConfigPath();

  if (!action || action === "list") {
    const current = loadConfig();
    console.log(`\nConfiguration (${configPath}):\n`);
    for (const [k, v] of Object.entries(current)) {
      console.log(`  ${k.padEnd(20)} = ${JSON.stringify(v)}`);
    }
    console.log("");
    return;
  }

  if (action === "get") {
    if (!key) {
      console.error("Error: Please specify a key. Example: orchestrator config get workerModel");
      process.exit(1);
    }
    const current = loadConfig();
    if (key in current) {
      console.log(current[key]);
    } else {
      console.error(`Error: Unknown key '${key}'`);
      process.exit(1);
    }
    return;
  }

  if (action === "set") {
    if (!key || value === undefined) {
      console.error("Error: Please specify both key and value. Example: orchestrator config set workerModel gemini-3.8-flash");
      process.exit(1);
    }
    try {
      const updated = setConfigValue(key, value);
      console.log(`✓ Updated '${key}' to ${JSON.stringify(updated[key])}`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (action === "reset") {
    resetConfig();
    console.log(`✓ Configuration reset to defaults at ${configPath}`);
    return;
  }

  console.error(`Error: Unknown action '${action}'. Use: list, get, set, reset`);
  process.exit(1);
}
