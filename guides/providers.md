# Providers

What each of the 12 providers can do as the lead or as a worker, and notes verified against the installed CLIs. Back to the [README](../README.md).

## What Each Provider Can Do

Every provider can be selected for either role, but not every pairing does real work:

| Provider | As orchestrator | As worker |
|---|---|---|
| `codex` | Delegates (bridge passed per thread via `thread/start`); live quotas; approval prompts | Reads and writes files (`codex exec --sandbox …`) |
| `claude` | Delegates (`--mcp-config` + `--allowedTools mcp__kumo-bridge`); streams answers and worker calls (`--output-format stream-json`); resumable conversations; Claude subscription limits | Reads and writes files; read-only tasks cannot edit (see below) |
| `antigravity` | Delegates (via `.agents/mcp_config.json` in the workspace); resumable conversations | Reads and writes files |
| `cursor`, `copilot`, `opencode`, `commandcode` | Answers on its own — **cannot call worker tools** | Reads and writes files |
| `ollama` | Answers on its own — **cannot call worker tools** | Text only: sees only the files you pass in `files` (contents are inlined); refused for writes |
| `openai-api`, `anthropic-api`, `gemini-api`, `compat-api` | Single-shot chat, no tools, no memory between turns | Text only, like `ollama` |

When a session starts with an orchestrator that cannot delegate, Kumo says so. A text-only worker asked to explore with no `files`, or to write in `autonomous` mode, is refused with a `[REFUSED]` result instead of returning invented output. In `diff-review` mode a text-only worker can still propose a diff, which Kumo applies itself. A worker that exits successfully without answering (its reason only on stderr) is reported as `[NO OUTPUT]` with that reason.

Provider notes, verified against the installed CLIs (codex-cli 0.153, Claude Code 2.1, agy 1.2):

- **Claude Code (`claude`), on your Claude subscription.** Kumo runs the official CLI in print mode with your own login; it never handles your Claude credentials. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are not passed to it (print mode would otherwise bill that key without asking), and if Claude Code reports any other key source, the session warns you. Use the `anthropic-api` provider when you want API billing. Only `kumo-bridge` is started for it (`--strict-mcp-config`). A read-only Claude worker runs with `--permission-mode dontAsk` and `Edit`, `Write` and `NotebookEdit` denied, so allow rules in your own settings cannot let it edit; read-only shell commands (`ls`, `git status`) still run. The `claude`, `claude-sonnet` and `claude-flash` presets set it up.

- **Codex orchestrator.** Codex asks before every MCP tool call. Kumo allows calls to its own `kumo-bridge` automatically, because what the worker may do is already governed by the safety mode. Calls to any other MCP server go to you as a REPL prompt, and `kumo run` declines them. Codex starts MCP servers with a filtered environment, so Kumo forwards its `KUMO_*` settings, CLI overrides and API keys to the bridge by name. The first turn waits until the bridge reports it is ready. If your configured model is not on your account's Codex model list, the session warns you and names the models you can use.
- **Antigravity (`agy`) as a worker.** Headless agy auto-denies any tool that needs a permission prompt, and that includes the shell commands it uses to list files. Read-only tasks therefore come back `[NO OUTPUT]` (with agy's explanation) unless you allow the read-only commands you want under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. Otherwise, pick Codex or Claude as the worker for exploration and review. Write tasks run with `--dangerously-skip-permissions` and are unaffected.
- **No recursion.** Workers cannot call back into Kumo: a bridge started inside a worker refuses every call, and Codex workers switch off `kumo-bridge` when a Codex config defines it.
