/**
 * cli.js — Main CLI router for Kumo using commander.
 */

import { Command } from "commander";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { doctorCommand } from "./commands/doctor.js";
import { configCommand } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { modelCommand, effortCommand } from "./commands/model.js";
import { bannerCommand } from "./commands/banner.js";
import { statusCommand } from "./commands/status.js";
import { graphCommand } from "./commands/graph.js";

export function createCli() {
  const program = new Command();

  program
    .name("kumo")
    .description("KUMO — Cross-provider CLI orchestrator pairing frontier reasoning models with high-speed execution workers")
    .version("1.0.0");

  // Default interactive command (launches new window and closes old CMD by default)
  program
    .option("-d, --dir <path>", "Target workspace directory (defaults to current working directory)")
    .option("--here", "Force running in current terminal (do not spawn new window)")
    .action(async (opts) => {
      await startCommand(opts);
    });

  // Explicit start command
  program
    .command("start")
    .description("Start an interactive orchestration session in the target workspace")
    .option("-d, --dir <path>", "Target workspace directory")
    .option("--here", "Force running in current terminal")
    .action(async (opts) => {
      await startCommand(opts);
    });

  // Live status and usage limits command
  program
    .command("status")
    .description("Display live orchestrator quota, rate limits, reset countdown, and worker health")
    .option("-d, --dir <path>", "Target workspace directory")
    .action(async (opts) => {
      await statusCommand(opts);
    });

  // Quota alias
  program
    .command("quota")
    .description("Display live orchestrator and worker quotas (alias for status)")
    .option("-d, --dir <path>", "Target workspace directory")
    .action(async (opts) => {
      await statusCommand(opts);
    });

  // Usage alias
  program
    .command("usage")
    .description("Display live orchestrator and worker quotas (alias for status)")
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
    .action(async (action, target, value, extra) => {
      await modelCommand(action, target, value, extra);
    });

  // Effort command (inspect or set reasoning effort for orchestrator or worker)
  program
    .command("effort [target] [value]")
    .description("Inspect or set reasoning effort for orchestrator (low, medium, high, max) or worker (e.g. kumo effort worker low)")
    .action((target, value) => {
      effortCommand(target, value);
    });

  // Reasoning alias
  program
    .command("reasoning [target] [value]")
    .description("Inspect or set reasoning effort (alias for effort)")
    .action((target, value) => {
      effortCommand(target, value);
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
    .command("banner")
    .description("Display the KUMO Cloud Cumulus banner")
    .action(() => {
      bannerCommand();
    });

  // Graph command
  program
    .command("graph")
    .description("Inspect Graphify knowledge graph freshness and lifecycle status")
    .option("-d, --dir <path>", "Target workspace directory")
    .option("--json", "Output status as JSON")
    .action(async (opts) => {
      await graphCommand(opts);
    });

  return program;
}
