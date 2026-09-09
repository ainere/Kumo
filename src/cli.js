/**
 * cli.js — Main CLI router for Kumo using commander.
 */

import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { doctorCommand } from "./commands/doctor.js";
import { configCommand } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { modelCommand } from "./commands/model.js";
import { bannerCommand } from "./commands/banner.js";
import { statusCommand } from "./commands/status.js";

export function createCli() {
  const program = new Command();

  program
    .name("kumo")
    .description("KUMO — Cross-provider CLI orchestrator pairing frontier reasoning models with high-speed execution workers")
    .version("1.0.0");

  // Default interactive command (when invoked without subcommand)
  program
    .option("-d, --dir <path>", "Target workspace directory (defaults to current working directory)")
    .option("-w, --new-window", "Launch Kumo in a separate dedicated terminal window")
    .option("--here", "Force running in current terminal (do not spawn new window)")
    .action(async (opts) => {
      await startCommand(opts);
    });

  // Explicit start command
  program
    .command("start")
    .description("Start an interactive orchestration session in the target workspace")
    .option("-d, --dir <path>", "Target workspace directory")
    .option("-w, --new-window", "Launch Kumo in a separate dedicated terminal window")
    .option("--here", "Force running in current terminal")
    .action(async (opts) => {
      await startCommand(opts);
    });

  // Dedicated launch command (alias for start --new-window)
  program
    .command("launch")
    .description("Launch Kumo in a dedicated new terminal window")
    .option("-d, --dir <path>", "Target workspace directory")
    .action(async (opts) => {
      await startCommand({ ...opts, newWindow: true });
    });

  // Live status and usage limits command
  program
    .command("status")
    .description("Display live orchestrator quota, rate limits, reset countdown, and worker health")
    .option("-d, --dir <path>", "Target workspace directory")
    .action(async (opts) => {
      await statusCommand(opts);
    });

  // Headless one-shot run command
  program
    .command("run <prompt>")
    .description("Execute a single task non-interactively across providers")
    .option("-d, --dir <path>", "Target workspace directory")
    .action(async (prompt, opts) => {
      await runCommand(prompt, opts);
    });

  // Model command (switch, inspect, or preset)
  program
    .command("model [action] [target] [value] [extra]")
    .description("Inspect or switch orchestrator and worker models (e.g. kumo model, kumo model orchestrator <m>, kumo model worker <m>)")
    .action((action, target, value, extra) => {
      modelCommand(action, target, value, extra);
    });

  // Doctor command
  program
    .command("doctor")
    .description("Verify subscription logins, binary availability, and MCP bridge status")
    .action(async () => {
      await doctorCommand();
    });

  // Config command
  program
    .command("config [action] [key] [value]")
    .description("Manage global settings: list, get <key>, set <key> <val>, reset")
    .action((action, key, value) => {
      configCommand(action, key, value);
    });

  // Init command
  program
    .command("init")
    .description("Scaffold project rules (AGENTS.md and GEMINI.md) in the current directory")
    .option("-d, --dir <path>", "Target directory")
    .option("--dry-run", "Preview files without writing to disk")
    .action((opts) => {
      initCommand(opts);
    });

  // Banner command
  program
    .command("banner [style]")
    .description("Showcase and switch between cloud banner styles (cloud, cloud-cumulus, cloud-kanji, cloud-minimal)")
    .action((style) => {
      bannerCommand(style);
    });

  return program;
}
