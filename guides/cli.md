# CLI Reference

Every `kumo` command and the slash commands inside a session. Back to the [README](../README.md).

## CLI Reference

| Command | Description |
|---|---|
| `kumo` | Launch interactive session in a dedicated window (the terminal you started it from stays open) |
| `kumo --here` | Launch interactive session directly in current terminal |
| `kumo -d, --dir <path>` | Launch interactive session in a specified directory |
| `kumo start [-d, --dir <path>] [--here]` | Start an interactive orchestration session in the target workspace |
| `kumo run "<prompt>" [-d, --dir <path>]` | Execute a single task non-interactively across providers |
| `kumo status [-d, --dir <path>]` | View account rate limits, usage quotas, and provider health (runs no model, so it costs no quota) |
| `kumo quota [-d, --dir <path>]` | Display live orchestrator and worker quotas (alias for `status`) |
| `kumo usage [-d, --dir <path>]` | Display live orchestrator and worker quotas (alias for `status`) |
| `kumo model` | Open interactive arrow-key selector (`/model` in session) |
| `kumo model list` | Print complete list of available models and presets |
| `kumo model orchestrator <model> [effort] [provider]` | Configure orchestrator model, effort, and explicit provider (13 ids) |
| `kumo model worker <model> [effort] [provider]` | Configure worker model, effort, and explicit provider (13 ids) |
| `kumo model use <preset>` | Apply configuration preset (`default`, `pro`, `speed`, `claude`, `claude-sonnet`, `claude-flash`, `opus-astra`, `opus-flash`, `argon`, `test`) |
| `kumo role` (`kumo role list`) | Show the lead and each role, its tool, access and the model it runs on (`/role` in session) |
| `kumo role set <role> <model> [effort] [provider]` | Assign a model to a role; `lead` sets the orchestrator, model `default` puts a role back on the shared worker |
| `kumo role add <id> --access read\|write --prompt-file <f> [--model <m>] [--effort <e>] [--provider <p>] [--name <n>] [--description <d>]` | Add a custom role, exposed to the lead as `worker_<id>` |
| `kumo role remove <id>` | Remove a custom role |
| `kumo effort <level>` | Set orchestrator reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`; which ones a model has: [roles and models](roles-and-models.md)) |
| `kumo effort worker <level>` | Set worker reasoning effort (same levels) |
| `kumo reasoning [target] [value]` | Inspect or set reasoning effort for orchestrator or worker (alias for `effort`) |
| `kumo graph [-d, --dir <path>]` | Inspect Graphify knowledge graph freshness and lifecycle status |
| `kumo graph --check` | Verify graph freshness and exit with code 1 if stale (CI-safe) |
| `kumo graph --refresh` | View instructions to regenerate the knowledge graph |
| `kumo graph --json` | Output Graphify knowledge graph status as JSON |
| `kumo doctor` | Perform diagnostic check on system environment, logins, and direct-API key presence |
| `kumo config list` | View global configuration keys and values (`~/.kumo/config.json`) |
| `kumo config get <key>` | View the value of a specific configuration property |
| `kumo config set <key> <val>` | Update a specific configuration property (incl. `<name>BaseUrl` overrides) |
| `kumo config reset` | Reset global configuration to defaults |
| `kumo init [-d, --dir <path>]` | (Optional) Initialize repository rule files (`AGENTS.md`, `GEMINI.md`) and opt the workspace in to provider-config sync (`.codex/config.toml`, `.codex/agents/reviewer.toml`, `.agents/mcp_config.json`) |
| `kumo init --dry-run` | Preview what `kumo init` would write, without writing to disk |
| `kumo banner` | Display the KUMO Cloud Cumulus banner |
| `kumo version` | Print the Kumo version |

## In-Session Slash Commands

Inside an interactive Kumo session (`kumo ›`), manage sessions, workspaces, models, quotas, and history without exiting:

### Session & Workspaces
- `/new`: Start a fresh conversation thread in the current workspace.
- `/chats`: Interactive arrow-key menu to browse and resume previous conversations (the orchestrator gets the earlier turns back where its provider supports it).
- `/projects`: Interactive arrow-key menu to browse and switch registered project workspaces.
- `/cd <path>`: Switch active workspace directory on the fly.
- `/rename <title>`: Rename the active conversation thread.
- `/save [file]`: Export conversation transcript to a Markdown document inside the workspace (default `kumo-session-<date>.md`). Give a file name or a path under the workspace, ending in `.md`. Paths outside it, the `.git`, `.codex`, `.claude`, `.agents` and `.gemini` folders, hard-linked files, and agent-instruction files (`AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`) are refused.

### Models & Reasoning
- `/model`: Opens the interactive arrow-key model & provider picker.
- `/model <name>`: Quick-switches orchestrator model (e.g. `/model opus`, `/model astra`, `/model sol`). The current provider is kept when it offers the model, otherwise the model's own provider is used.
- `/model worker <name> [effort]`: Quick-switches the shared worker model and effort (e.g. `/model worker haiku`, `/model worker flash high`); roles without their own model follow it.
- `/role`: Shows the lead and each role, its tool, and the model it runs on in this session.
- `/role <role> <model> [effort] [provider]`: Assigns a model to a role (e.g. `/role builder sonnet`, `/role reviewer astra high`, `/role lead opus`); `default` puts a role back on the shared worker.
- `/preset [name]`: Applies a configuration preset (e.g. `/preset pro`, `/preset speed`) or lists available presets.
- `/effort <level>`: Sets orchestrator reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`).
- `/effort worker <level>`: Sets worker reasoning effort (same levels).

### Quotas, History & Utilities
- `/status`, `/quota`: Checks live account rate limits, quota progress bars, and provider health.
- `/refresh`: Re-fetches live quotas immediately from the active providers.
- `/history clean`: Strips non-chat commands and settings changes from history file.
- `/history clear` (or `/clear-history`): Completely wipes prompt history.
- `/clear` (or `/cls`): Clears screen and re-renders the header banner.
- `/help`: Displays categorized command reference.
- `/exit` (or `/quit`): Exits session cleanly.
