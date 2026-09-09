/**
 * config.js — CLI command to inspect and update user configuration.
 */

import {
  loadConfig,
  saveConfig,
  setConfigValue,
  resetConfig,
  getConfigPath,
  DEFAULT_CONFIG,
} from "../config/settings.js";
import { c, badge, separator } from "../utils/ui.js";

export function configCommand(action, key, value) {
  const configPath = getConfigPath();

  // 1. kumo config / kumo config list
  if (!action || action === "list") {
    const config = loadConfig();
    console.log(`\n${c.bold}Configuration${c.reset} ${c.dim}(${configPath})${c.reset}`);
    console.log(separator(50));
    for (const [k, v] of Object.entries(config)) {
      console.log(`  ${c.dim}${k.padEnd(22)}:${c.reset} ${JSON.stringify(v)}`);
    }
    console.log("");
    return;
  }

  // 2. kumo config get <key>
  if (action === "get") {
    if (!key) {
      console.error(`${badge.fail} Please specify a configuration key.`);
      process.exit(1);
    }
    const config = loadConfig();
    if (key in config) {
      console.log(config[key]);
    } else {
      console.error(`${badge.fail} Key '${key}' not found in configuration.`);
      process.exit(1);
    }
    return;
  }

  // 3. kumo config set <key> <value>
  if (action === "set") {
    if (!key || value === undefined) {
      console.error(`${badge.fail} Usage: kumo config set <key> <value>`);
      process.exit(1);
    }

    try {
      const updated = setConfigValue(key, value);
      console.log(`${badge.ok} Updated '${key}' to ${JSON.stringify(updated[key])}`);
    } catch (err) {
      console.error(`${badge.fail} ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // 4. kumo config reset
  if (action === "reset") {
    resetConfig();
    console.log(`${badge.ok} Configuration reset to defaults at ${configPath}`);
    return;
  }

  console.error(`${badge.fail} Unknown config action '${action}'. Available: list, get, set, reset.`);
  process.exit(1);
}
