/**
 * cli.js — Main CLI router for Kumo using commander.
 */

import { Command } from "commander";
import { VERSION } from "./version.js";
import { startCommand } from "./commands/start.js";
import { runCommand } from "./commands/run.js";
import { doctorCommand } from "./commands/doctor.js";
import { configCommand } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { modelCommand, effortCommand } from "./commands/model.js";
import { bannerCommand } from "./commands/banner.js";
import { statusCommand } from "./commands/status.js";
import { graphCommand } from "./commands/graph.js";
import { roleListCommand, roleSetCommand, roleAddCommand, roleRemoveCommand } from "./commands/role.js";
import { badge } from "./utils/ui.js";

export { VERSION };

/** Run a command that throws on bad input: print the message and exit 1. */
function failing(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`${badge.fail} ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  };
}

export function createCli() {
  const program = new Command();

  program
    .name("kumo")
    .description("KUMO — Cross-provider CLI orchestrator pairing frontier reasoning models with high-speed execution workers")
    .version(VERSION)
    // The root command and most subcommands all define `-d, --dir`. Without
    // this, commander lets the root claim the option anywhere on the line, so
    // `kumo run "…" -d <path>` silently ran in the current directory.
    .enablePositionalOptions();

  // Default interactive command (opens Kumo in a new terminal window unless --here)
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

  // Role command: which model runs the lead and each worker role
  const role = program
    .command("role")
    .description("Show or change which model runs the lead and each role (scout, builder, tester, researcher, reviewer, designer, custom)");
  role
    .command("list", { isDefault: true })
    .description("List the lead, every role, its tool and the model it runs on")
    .action(failing(() => roleListCommand()));
  role
    .command("set <role> <model> [effort] [provider]")
    .description("Assign a model to a role ('lead' sets the orchestrator; model 'default' puts a role back on the shared worker)")
    .action(failing((name, model, effort, provider) => roleSetCommand(name, model, effort, provider)));
  role
    .command("add <id>")
    .description("Add a custom role, exposed to the lead as the tool worker_<id>")
    .requiredOption("--prompt-file <file>", "File with the role's instructions (its system prompt)")
    .option("--access <access>", "read or write", "read")
    .option("--model <model>", "Model the role runs on (default: the shared worker)")
    .option("--effort <effort>", "Reasoning effort for that model")
    .option("--provider <provider>", "Provider for that model (default: inferred from the model)")
    .option("--name <name>", "Display name")
    .option("--description <text>", "One line telling the lead when to use the role")
    .action(failing((id, opts) => roleAddCommand(id, opts)));
  role
    .command("remove <id>")
    .description("Remove a custom role")
    .action(failing((id) => roleRemoveCommand(id)));

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
    .option("--check", "Exit with code 1 if graph is stale (useful for CI/scripts)")
    .option("--refresh", "Print instructions to regenerate the knowledge graph")
    .action(async (opts) => {
      await graphCommand(opts);
    });

  // Version command (explicit subcommand in addition to -V flag)
  program
    .command("version")
    .description("Print the Kumo version")
    .action(() => {
      console.log(VERSION);
    });

  return program;
}
