# KUMO — Cross-Provider AI Orchestration Harness

```text
         .---.                    
      .-(     ).    .---.           KUMO (雲) v1.0.0
    .(          ).-(     ).         Cross-Provider AI Orchestrator
   (____.__.__.____)(____)          Frontier Reasoning ◄───[MCP]───► High-Speed Execution
```

**Kumo** is a modular CLI application that pairs frontier reasoning models with high-throughput execution workers across independent AI ecosystems.

It coordinates frontier models across **Anthropic Claude** (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 and earlier, through the official Claude Code CLI or Antigravity), **OpenAI ChatGPT / Codex** (GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna, GPT-5.6), and **Google Gemini** (Gemini 4 Argon, Gemini 3.8 Flash) — with **13 providers to pick from for either role** (e.g. Claude Opus Orchestrator + Codex Worker, or Codex Orchestrator + Gemini Worker) running on your existing subscriptions by default, with optional direct API usage (metered env-var keys, never stored). Not every provider can do every job: only Codex, Claude Code and Antigravity can delegate to workers, and API/Ollama workers cannot touch files — see [What Each Provider Can Do](#what-each-provider-can-do).

---

## Architecture

```text
                          Global invocation:
                               $ kumo
                                 │
                                 ▼
                  ┌─────────────────────────────┐
                  │   KUMO CLI (REPL, kumo run)  │   (desktop app: planned,
                  └──────────────┬──────────────┘    same engine)
                                 │ typed events / commands
                  ┌──────────────▼──────────────┐
                  │   Engine (src/core)          │
                  │   • Session per chat         │
                  │   • Per-session settings     │
                  │   • Turns, tools, approvals  │
                  │   • Chats + provider threads │
                  └──────────────┬──────────────┘
                                 │ named pipe / unix socket ◄─ kumo-bridge
                                 │   (settings, worker output, approvals)
        ┌────────────────────────┴────────────────────────┐
        ▼                                                  ▼
┌───────────────────────────┐              ┌───────────────────────────┐
│   Orchestrator Provider   │              │      Worker Provider      │
│  (13 providers: 9 CLI +   │              │  (13 providers: 9 CLI +   │
│    4 direct API)          │ ◄───[MCP]───►│    4 direct API)          │
│   • Task decomposition    │              │   • File exploration      │
│   • Architectural design  │              │   • Code implementation   │
│   • Cross-model review    │              │   • Test generation & runs│
└───────────────────────────┘              └───────────────────────────┘
```

---

## Installation

Install dependencies and link the binary globally:

```powershell
npm install
npm link --force
```

After linking, `kumo` is available from any directory.

---

## How to Start and Do Work

### 1. Launch a Session
Navigate to any project directory and start Kumo:

```powershell
# Open interactive session in dedicated window
kumo

# Or run directly inside the current terminal
kumo --here

# Or run a single headless prompt across providers
kumo run "Explore src/ and summarize the architecture"
```

### 2. How the Orchestration Workflow Operates
Inside the interactive session (`kumo ›`):

1. **Enter High-Level Tasks**: Simply describe your goal in natural language:
   - **Feature development**: `"Implement JWT authentication in src/auth.js and write unit tests"`
   - **Code exploration**: `"Explore src/ and map out how the MCP bridge works"`
   - **Refactoring**: `"Refactor error handling in src/bridge/server.js with retries"`
   - **Testing & Debugging**: `"Run npm test and fix any failing edge cases"`

2. **Orchestrator Plans & Delegates**:
   - The **Orchestrator** (default: GPT-6 Astra; `kumo model use claude` for Claude Code) analyzes your prompt, formulates an execution plan, and calls worker tools (`worker_explore`, `worker_implement`, `worker_test`, etc.) via the local MCP stdio bridge.

3. **Execution Worker Executes**:
   - The **Worker** (default: Gemini 3.8 Flash) performs the heavy reading, editing, and test execution using its high-throughput context window at high speed.
   - **Quota Preservation**: The orchestrator never bloats its reasoning quota reading large codebase files directly.

4. **Review & Summary**:
   - The orchestrator verifies changes, runs tests, and presents a clean report back to you.

---

## Orchestration Protocol & Delegation Gate

Kumo adopts the proven role specialization and delegation structure of frontier agent orchestrators (such as [donvito/codex-astra-luna-orchestrator](https://github.com/donvito/codex-astra-luna-orchestrator)), mapped across independent providers:

### The Delegation Gate
To preserve orchestrator message quotas and reasoning capacity, the orchestrator strictly classifies tasks before executing:
- **Root-only**: Reserved exclusively for trivial 1-line edits in a known file or quick conversational Q&A.
- **Delegated (Mandatory)**: Tasks **MUST** be delegated via worker MCP tools (`worker_*`) whenever:
  - The task spans multiple files, modules, or services.
  - Exploration or code search is required.
  - Implementation requires writing or refactoring code.
  - Automated tests need to be created or executed.
  - Debugging requires tracing across files or reproducing errors.

The orchestrator is forbidden from performing delegated tasks in-thread; actual MCP tool calls must be made.

### Specialized Worker Roles & Schemas
| Role | Primary Tool | Permissions | Purpose & Schema |
|---|---|---|---|
| **Explorer** | `worker_explore` | Read-only | Finds files & symbols, traces call flows. Returns: 1) Relevant files/symbols, 2) Flow, 3) Constraints/risks, 4) Recommended implementation surface. |
| **Worker** | `worker_implement` | Workspace-write | Executes bounded changes. If scope is ambiguous, stops and escalates. Returns: 1) What changed, 2) Files modified, 3) Validation run, 4) Remaining risks. |
| **Tester** | `worker_test` | Workspace-write | Runs targeted tests, reproduces failures. Never rewrites production code to pass tests. Returns: 1) Commands run, 2) Pass/fail, 3) Output, 4) Gaps, 5) Next action. |
| **Researcher** | `worker_research` | Read-only | Verifies facts against primary documentation. Returns: 1) Verified answer, 2) Version assumptions, 3) Citations, 4) Uncertainties. |
| **Reviewer** | `worker_review` | Read-only | Pre-flight check before synthesis. Prioritizes bugs, security, regressions, and data integrity over style nitpicks. |

---

## Knowledge & Documentation Integrity

1. **Graphify (`graphify-out/`)**:
   - Code exploration consults `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`) when present as a structural map of clusters and god nodes. Always verify active symbols against current source code (`kumo graph --check` detects staleness).
2. **Obsidian Knowledge Vault**:
   - Lasting architectural decisions, verified multi-step procedures, and project handoffs are recorded in the shared Obsidian workspace (configured via `$KUMO_OBSIDIAN_VAULT` or `kumo config set obsidianVault <path>`).
3. **Immediate README Maintenance**:
   - **Whenever a major change is made** (features, commands, configuration, or architecture), **`README.md` must be updated immediately** to preserve documentation synchronization.

---

## Safety Modes & Guardrails

Kumo provides three safety modes for worker execution (`kumo config set safetyMode <mode>` or `KUMO_SAFETY_MODE`), governing both `worker_implement` and `worker_test`:

| Safety Mode | Behavior | Use Case |
|---|---|---|
| `autonomous` (Default) | Automatically applies file changes with no approval gate, then appends verified post-execution `[Applied Files & Diff Summary]` to tool output. | Fast headless execution, prototyping, internal repos. |
| `diff-review` | Two-phase programmatic preview gate: Phase 1 runs the worker read-only to produce a unified diff (`confirm: false`). Phase 2 runs only when the *calling orchestrator model* re-invokes with `confirm: true` and a matching `previewId`; Kumo then applies **exactly the approved diff** with `git apply` (checked first, so a stale patch leaves the tree untouched). Only if the diff no longer applies is the worker asked to redo the task with write permission, and the result says so and lists any divergence from the preview. Note the orchestrator model approves its own previews here — this is a review step, not a human gate. | Multi-turn programmatic validation, headless CI pipelines. |
| `interactive` | Same two phases, but Phase 2 first asks a human on the `kumo` REPL's TTY (`Approve? [y/N/d]`). The bridge asks the session over the engine connection; a bridge that cannot reach it falls back to approval files. If the approved diff no longer applies, nothing is written and a new preview is requested — the worker is never re-run with write access behind the operator's back. Without a REPL listening (e.g. `kumo run`), it behaves like `diff-review`. | Critical client work, production codebases, high-stakes manual oversight. |

The worker's permission is decided per call by the bridge, not by the safety mode: read-only tools and previews launch the worker read-only (e.g. `codex exec --sandbox read-only`), autonomous writes and confirmed re-runs launch it with write access (`--sandbox workspace-write`, `--dangerously-skip-permissions`, `--approval-mode yolo`, … depending on the CLI). Approval requests from the orchestrator itself (e.g. Codex wanting to run a command) are shown in the REPL as `y/N` prompts and declined automatically in `kumo run`.

---

## Features & Capabilities

- **Subscriptions by Default**: Connects directly to your logged-in consumer subscriptions across 9 CLI providers (`codex, antigravity, claude, opencode, commandcode, copilot, cursor, gemini-cli, ollama`) — zero keys on disk. Kumo never persists your keys. When it launches a worker CLI it forwards only the API keys that provider needs and strips other secret-looking environment variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*CREDENTIAL*`). This is best-effort defense in depth, not isolation: the name match can miss credentials (e.g. a `DATABASE_URL` with a password), most orchestrator CLIs receive your full environment (Claude Code does not get `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, so it stays on your subscription login), and a worker with write access can read any file your user can.
- **Direct API (optional, env keys never stored)**: `openai-api (OPENAI_API_KEY), anthropic-api (ANTHROPIC_API_KEY), gemini-api (GEMINI_API_KEY), compat-api (COMPAT_BASE_URL + optional COMPAT_API_KEY)` — per-role or per-call (`provider: "anthropic-api"`), mixed with subscriptions; non-secret base-URL overrides via `kumo config set <name>BaseUrl`.
- **Multi-Provider Architecture**: Frontier reasoning orchestrator breaks down complex architecture and dispatches bounded execution tasks to high-throughput workers via local MCP stdio bridge.
- **Per-Session Settings & Role Synchronization**: Each session (a REPL window, a `kumo run`, later each desktop chat) starts from the saved config and then keeps its own settings. The bridge asks its session for them on every call, so `/model worker …` applies to the next worker call without a restart, and switching the worker or safety mode in one window never changes a turn running in another. Model switches keep the conversation on every provider; a provider switch starts a new one. CLI changes are also saved as the new defaults. Worker prompts name the active models. Project files (`.codex/config.toml`, `.codex/agents/reviewer.toml`, `.agents/mcp_config.json`) are **opt-in**: `kumo init` creates them, and sessions then keep them current — Kumo never writes them into a workspace you have not initialized, never into the directory you happen to run `kumo config` from, never overwrites a `reviewer.toml` it did not create, and never redefines a key you set yourself in `config.toml`. The one exception is `.agents/mcp_config.json` (merged, not overwritten) when Antigravity is the orchestrator, because that is the only way it can reach the worker tools.
- **Multi-Chat Session Persistence**: Persistent local conversation index and turn logging under `~/.kumo/sessions/` (prompt and response per turn), chat switching (`/chats`) and Markdown export (`/save`). Each chat records its provider thread, and switching back resumes it, so the orchestrator has its earlier turns again (Codex `thread/resume`, Claude Code `--resume`, Antigravity `--conversation`). Providers without resume start a fresh conversation, and Kumo says so.
- **Global Project Registry**: Automatically tracks workspaces with quick switching (`/projects` or `/cd <path>`).
- **Provider-First Model Picker**: Arrow-key dialog (`/model` or `kumo model`) grouping Subscription CLIs and Direct API providers (see Model Configuration below) with atomic flicker-free redraw and back navigation.
- **Live Multi-Provider Quota Meters**: 5-hour, weekly, and monthly quota bars for the providers each role uses: Codex limits from its app-server, Claude subscription limits from the rate-limit report Claude Code sends with each turn, and Antigravity usage from `agy -p /usage`, which is only queried when a role uses Antigravity (at most every 5 minutes; it never runs a model). `kumo status` spends no model quota.
- **Prompt History & Smart Filtering**: Persistent command history (`~/.kumo/history.txt`) with automatic slash-command filtering (Up Arrow only cycles actual prompts).
- **Context-Aware Smart Suggestions**: Project type detection (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`) with inline recommended prompt actions.
- **Live Thinking Spinner & Timer**: Non-blocking animated terminal spinner with elapsed second timer and clean Ctrl+C task interruption.
- **Live Agent Visibility & Focus Switching**: Real-time worker output, streamed by the bridge over the engine connection and tagged with the call it belongs to (parallel calls no longer share one log), model & effort indicators (`gemini-3.8-flash, effort: medium`), dimmed reasoning deltas, ring-buffered streams, and `Tab` key stream focus switching between Orchestrator and active Worker subprocesses.

---

## What Each Provider Can Do

Every provider can be selected for either role, but not every pairing does real work:

| Provider | As orchestrator | As worker |
|---|---|---|
| `codex` | Delegates (bridge passed per thread via `thread/start`); live quotas; approval prompts | Reads and writes files (`codex exec --sandbox …`) |
| `claude` | Delegates (`--mcp-config` + `--allowedTools mcp__kumo-bridge`); streams answers and worker calls (`--output-format stream-json`); resumable conversations; Claude subscription limits | Reads and writes files; read-only tasks cannot edit (see below) |
| `antigravity` | Delegates (via `.agents/mcp_config.json` in the workspace); resumable conversations | Reads and writes files |
| `cursor`, `gemini-cli`, `copilot`, `opencode`, `commandcode` | Answers on its own — **cannot call worker tools** | Reads and writes files |
| `ollama` | Answers on its own — **cannot call worker tools** | Text only: sees only the files you pass in `files` (contents are inlined); refused for writes |
| `openai-api`, `anthropic-api`, `gemini-api`, `compat-api` | Single-shot chat, no tools, no memory between turns | Text only, like `ollama` |

When a session starts with an orchestrator that cannot delegate, Kumo says so. A text-only worker asked to explore with no `files`, or to write in `autonomous` mode, is refused with a `[REFUSED]` result instead of returning invented output. In `diff-review` mode a text-only worker can still propose a diff, which Kumo applies itself. A worker that exits successfully without answering (its reason only on stderr) is reported as `[NO OUTPUT]` with that reason.

Provider notes, verified against the installed CLIs (codex-cli 0.153, Claude Code 2.1, agy 1.2):

- **Claude Code (`claude`), on your Claude subscription.** Kumo runs the official CLI in print mode with your own login; it never handles your Claude credentials. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are not passed to it (print mode would otherwise bill that key without asking), and if Claude Code reports any other key source, the session warns you. Use the `anthropic-api` provider when you want API billing. Only `kumo-bridge` is started for it (`--strict-mcp-config`). A read-only Claude worker runs with `--permission-mode dontAsk` and `Edit`, `Write` and `NotebookEdit` denied, so allow rules in your own settings cannot let it edit; read-only shell commands (`ls`, `git status`) still run. The `claude`, `claude-sonnet` and `claude-flash` presets set it up.

- **Codex orchestrator.** Codex asks before every MCP tool call. Kumo allows calls to its own `kumo-bridge` automatically, because what the worker may do is already governed by the safety mode. Calls to any other MCP server go to you as a REPL prompt, and `kumo run` declines them. Codex starts MCP servers with a filtered environment, so Kumo forwards its `KUMO_*` settings, CLI overrides and API keys to the bridge by name. The first turn waits until the bridge reports it is ready. If your configured model is not on your account's Codex model list, the session warns you and names the models you can use.
- **Antigravity (`agy`) as a worker.** Headless agy auto-denies any tool that needs a permission prompt, and that includes the shell commands it uses to list files. Read-only tasks therefore come back `[NO OUTPUT]` (with agy's explanation) unless you allow the read-only commands you want under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. Otherwise, pick Codex or Claude as the worker for exploration and review. Write tasks run with `--dangerously-skip-permissions` and are unaffected.
- **No recursion.** Workers cannot call back into Kumo: a bridge started inside a worker refuses every call, and Codex workers switch off `kumo-bridge` when a Codex config defines it.

---

## Model Configuration & Arrow-Key Navigation

Kumo provides dual-layer model configuration: an interactive arrow-key selector and direct CLI / in-session commands.

### 1. Interactive Model Picker (`/model` or `kumo model`)

Launch the arrow-key menu by running `kumo model` in your terminal or typing `/model` inside an active interactive session:

- **Arrow-Key Navigation**: Navigate options with `↑` / `↓`, jump with `Home` / `End`, page with `PageUp` / `PageDown`, press `Enter` to select, or press `Left Arrow` / `Esc` to go back.
- **Provider-First Model Picker**: Arrow-key dialog (`/model` or `kumo model`) grouping Subscription CLIs (`codex, antigravity, claude, opencode, commandcode, copilot, cursor, gemini-cli, ollama`) and Direct API (`openai-api, anthropic-api, gemini-api, compat-api` — env keys, never stored) with atomic flicker-free redraw and back navigation.
- **Dynamic Quota Synchronization**: The startup header and `/status` command automatically adapt their quota progress bars to reflect the provider chosen for each role.

### 2. Built-in Presets

| Preset | Orchestrator | Effort | Worker | Effort | Target Usage |
|---|---|---|---|---|---|
| `default` | `gpt-6-astra` (codex) | `low` | `gemini-3.8-flash` (antigravity) | `medium` | Everyday development (ChatGPT + Google AI Pro) |
| `pro` | `gpt-6-astra` (codex) | `medium` | `gemini-3.8-flash` (antigravity) | `high` | Complex architecture & deep reasoning (ChatGPT Pro) |
| `speed` | `gpt-6-luna` (codex) | `low` | `gemini-3.8-flash` (antigravity) | `low` | High-speed iteration and rapid turnaround |
| `claude` | `claude-opus-5-5` (claude) | `medium` | `claude-haiku-5-5` (claude) | `low` | Everything on your Claude subscription, through Claude Code |
| `claude-sonnet` | `claude-sonnet-5-5` (claude) | `low` | `claude-haiku-5-5` (claude) | `low` | Lighter Claude Code pairing that stretches usage |
| `claude-flash` | `claude-opus-5-5` (claude) | `medium` | `gemini-3.8-flash` (antigravity) | `medium` | Claude Code orchestrator + Antigravity worker |
| `opus-astra` | `claude-opus-5-5` (antigravity) | `high` | `gpt-6-astra` (codex) | `low` | Claude Opus via Google AI Pro + Codex worker |
| `opus-flash` | `claude-opus-5-5` (antigravity) | `high` | `gemini-3.8-flash` (antigravity) | `medium` | Claude Opus and Gemini, both on Google AI Pro |
| `argon` | `gemini-4-argon` (antigravity) | `medium` | `gemini-3.8-flash` (antigravity) | `medium` | All-Google pairing |
| `test` | `gpt-6-luna` (codex) | `low` | `gemini-3.8-flash` (antigravity) | `low` | Lowest quota verification |

The model lists live in one catalog (`src/config/models.js`): Codex models as OpenAI's Codex docs list them (`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-sol`, the GPT-5.6 family), the current Claude lineup with Claude Code's aliases (`fable`, `opus`, `sonnet`, `haiku`), and Antigravity's models as `agy models` lists them. Codex and Antigravity show their live lists in the picker when they can. A config with an old id Kumo used to write (`chatgpt-6-astra`, `chatgpt-5.6-sol`) is read as the real model. Effort levels for both roles: `low`, `medium`, `high`, `xhigh`, `max`.

### 3. CLI Commands

Configure models, reasoning efforts, and providers directly from your shell:

```powershell
# Open interactive arrow-key selector
kumo model

# View full model configuration, active providers, and available presets
kumo model list

# Set orchestrator model, optional effort, and optional provider
# (auto-detects provider: claude-* -> claude (Claude Code), gpt-6-astra -> codex, gemini-* -> antigravity)
kumo model orchestrator opus
kumo model orchestrator gpt-6-astra low codex
kumo model orchestrator claude-opus-5-5 high antigravity

# Set worker model, optional effort, and optional provider
kumo model worker haiku low
kumo model worker gemini-3.8-flash medium
kumo model worker gpt-6-luna low codex

# Direct API per-role (env keys only, never stored)
kumo model worker gpt-6-luna low openai-api
kumo model orchestrator claude-opus-5-5 high anthropic-api

# Set reasoning effort (low, medium, high, xhigh, max)
kumo effort medium
kumo effort worker low

# Apply a preset profile
kumo model use claude
kumo model use default
kumo model use opus-flash

# Quick shorthand to set both orchestrator and worker
kumo model opus haiku
kumo model gpt-6-luna gemini-3.8-flash low
```

### 4. In-Session Slash Commands

Inside an interactive Kumo session (`kumo ›`), manage sessions, workspaces, models, quotas, and history without exiting:

#### Session & Workspaces
- `/new`: Start a fresh conversation thread in the current workspace.
- `/chats`: Interactive arrow-key menu to browse and resume previous conversations (the orchestrator gets the earlier turns back where its provider supports it).
- `/projects`: Interactive arrow-key menu to browse and switch registered project workspaces.
- `/cd <path>`: Switch active workspace directory on the fly.
- `/rename <title>`: Rename the active conversation thread.
- `/save [file]`: Export conversation transcript to a Markdown document.

#### Models & Reasoning
- `/model`: Opens the interactive arrow-key model & provider picker.
- `/model <name>`: Quick-switches orchestrator model (e.g. `/model opus`, `/model astra`, `/model sol`). The current provider is kept when it offers the model, otherwise the model's own provider is used.
- `/model worker <name> [effort]`: Quick-switches worker model and effort (e.g. `/model worker haiku`, `/model worker flash high`).
- `/preset [name]`: Applies a configuration preset (e.g. `/preset pro`, `/preset speed`) or lists available presets.
- `/effort <level>`: Sets orchestrator reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`).
- `/effort worker <level>`: Sets worker reasoning effort (same levels).

#### Quotas, History & Utilities
- `/status`, `/quota`: Checks live account rate limits, quota progress bars, and provider health.
- `/refresh`: Re-fetches live quotas immediately from the active providers.
- `/history clean`: Strips non-chat commands and settings changes from history file.
- `/history clear` (or `/clear-history`): Completely wipes prompt history.
- `/clear` (or `/cls`): Clears screen and re-renders the header banner.
- `/help`: Displays categorized command reference.
- `/exit` (or `/quit`): Exits session cleanly.

---

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
| `kumo effort <level>` | Set orchestrator reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`) |
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

---

## Environment Variables

Kumo inspects the following environment variables to configure workspaces, execution parameters, endpoints, and runtime behavior:

| Variable | Read At | Purpose |
|---|---|---|
| `KUMO_WORKSPACE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Target workspace directory for the MCP bridge |
| `ORCHESTRATOR_WORKSPACE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Legacy fallback for `KUMO_WORKSPACE` |
| `KUMO_HOME` | `src/config/paths.js` | Overrides the `~/.kumo` state directory (used for testing and isolated sessions) |
| `KUMO_NO_SYNC` | `src/config/sync.js` | Set to `1` to disable every provider-config write, including `kumo init`'s sync and Antigravity's `.agents/mcp_config.json` |
| `KUMO_LIVE_TESTS` | `tests/` | Set to `1` to also run tests that call real CLIs and accounts (Codex rate limits, Codex protocol schema check) |
| `KUMO_SAFETY_MODE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Override safety mode (`autonomous`, `diff-review`, `interactive`) |
| `KUMO_HERE` | `src/commands/start.js` | Run interactive session directly in current terminal (equivalent to `--here`) |
| `KUMO_DEBUG` | `src/providers/orchestrators/agy-client.js`, `src/providers/orchestrators/codex-client.js` | Enable verbose client notification and tool-call logging |
| `KUMO_TRUST_WORKSPACE` | `src/bridge/agy-runner.js` | Set to `false` to stop passing `--skip-trust` to worker subprocesses |
| `KUMO_SKIP_TRUST` | `src/bridge/agy-runner.js` | Alias for `KUMO_TRUST_WORKSPACE` |
| `KUMO_WORKER_PROVIDER` | `src/bridge/server.js` | Per-environment worker provider override (takes precedence over `config.workerProvider`) |
| `KUMO_SYNC_GLOBAL_GEMINI` | `src/config/sync.js` | Set to `1` to opt in to writing global `~/.gemini/config/mcp_config.json` |
| `KUMO_OBSIDIAN_VAULT` | `src/config/settings.js` | Absolute path to your Obsidian knowledge vault |
| `GEMINI_MODEL` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Override worker model for execution worker dispatches |
| `GEMINI_EFFORT` / `WORKER_EFFORT` | `src/bridge/agy-runner.js` | Override worker reasoning effort (`low`, `medium`, `high`) |
| `GEMINI_TIMEOUT_MS` | `src/bridge/agy-runner.js` | Execution worker subprocess timeout in milliseconds (default: 300000 / 5m) |
| `AGY_BIN` / `CODEX_BIN` / `CLAUDE_BIN` / `OLLAMA_BIN` / … | provider adapters | Absolute path to a provider CLI, overriding PATH lookup |
| `OPENAI_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `openai-api` provider |
| `ANTHROPIC_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `anthropic-api` provider |
| `GEMINI_BASE_URL` / `GOOGLE_GENERATIVE_AI_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `gemini-api` provider |
| `KUMO_ENGINE_ENDPOINT` / `KUMO_SESSION_TOKEN` | `src/bridge/server.js` | Set by a Kumo session for the orchestrator it starts, so the bridge can reach that session (named pipe or 0700 unix socket, per-session token). Not for manual use. |
| `KUMO_STRICT_EVENTS` | `src/core/events.js` | Set to `1` to validate every engine event against its schema (the test suite does) |

Timeouts are configured separately: `timeoutMs` (default 5 min) bounds each worker call, `turnTimeoutMs` (default 30 min) bounds a whole orchestrator turn. A timed-out or Ctrl+C'd turn is interrupted at the orchestrator, and the prompt returns only once it has actually stopped. The Antigravity provider prefers the `agy` binary; set `cliBinary` (or `AGY_BIN`) to override it, or choose the `gemini-cli` provider to use the Gemini CLI as a worker.

---

## Architecture & Extensibility

The codebase implements a decoupled, unhardcoded provider and data persistence structure:
- **Engine** ([`src/core/`](src/core/)) — shared by the CLI and, later, the desktop app:
  - `session.js`: `Session`, one conversation in one workspace. It owns the orchestrator client, turns, worker calls and their output, approvals, the chat record and its provider thread, quotas and its own settings, and reports everything as events. Its commands: `start`, `send`, `interrupt`, `newChat`, `openChat`, `setWorkspace`, `updateSettings`, `resolveApproval`, `exportMarkdown`, `stop`.
  - `session-manager.js`: several sessions side by side, one event stream.
  - `events.js`: the event contract (`turn.*`, `tool.*`, `approval.*`, `quota.updated`, `session.*`, `settings.changed`, `chat.changed`) as zod schemas, with the JSDoc types inferred from them.
  - `ipc/`: the engine ↔ bridge connection, NDJSON JSON-RPC over a named pipe or unix socket, with a per-session token. The bridge asks for settings and approvals there and streams each run's output tagged with its run.
  - `tool-tracker.js`, `live-log-tailer.js`, `quota-monitor.js`, `settings.js`: call/run matching, the file fallback for bridges without an engine, quota polling, and per-session settings.
  - `vendor/codex-protocol/`: Codex app-server types generated by `npm run refresh:codex-protocol`.
- **Model catalog** ([`src/config/models.js`](src/config/models.js)): every provider's models, aliases, provider detection and plan labels in one place.
- **Orchestrators** ([`src/providers/orchestrators/`](src/providers/orchestrators/)):
  - `codex-client.js`: OpenAI Codex app-server client supporting streaming turns, live rate limits, turn status, and server→client approval requests (shapes follow `codex app-server generate-json-schema`).
  - `agy-client.js`: Google Antigravity / Gemini CLI client supporting stream-json turns.
  - `claude-client.js`: Anthropic Claude Code CLI client: print-mode stream-json turns with the bridge via `--mcp-config`, headless tool permission, resumable sessions and subscription rate limits.
  - `turn-wait.js`: `runTurn()` — attaches terminal-event listeners before submitting, interrupts on timeout or Ctrl+C.
  - `items.js`: provider-neutral helpers for recognizing tool-call items (`mcpToolCall`, `mcp_tool_call`, …).
  - `opencode-client.js`: OpenCode CLI client.
  - `commandcode-client.js`: CommandCode CLI client.
  - `copilot-client.js`: GitHub Copilot CLI client (`gh copilot`).
  - `cursor-client.js`: Cursor Agent CLI client (`cursor-agent`).
  - `gemini-cli-client.js`: Standalone Gemini CLI client (`gemini`, distinct from `agy`).
  - `ollama-client.js`: Ollama local runner client (`ollama run <model>`).
  - `generic-client.js`: Universal CLI orchestrator adapter that can drive any arbitrary AI CLI tool without hardcoding.
  - `registry.js`: Open-ended orchestrator provider registry and factory (13 providers incl. direct APIs), with `orchestratorDelegates()` reporting which can reach the worker tools.
- **Direct-API transport** ([`src/providers/api/`](src/providers/api/)):
  - `api-transport.js`: Zero-dependency native-fetch transport (`getApiKey`, `resolveBaseUrl`, `ApiError`, `chatComplete`); keys live only in env vars, never on disk.
  - `openai-api-client.js` (+ `compat-api` via `provider` option), `anthropic-api-client.js`, `gemini-api-client.js`: single-shot orchestrator clients behind the standard client surface (`getRateLimits()` always `null`).
  - `api-worker.js`: shared `executeApiTask` composing the standard composite-prompt blocks over `chatComplete`.
- **Workers** ([`src/providers/workers/`](src/providers/workers/)):
  - `gemini.js`: Google Gemini adapter backed by Antigravity / Gemini CLI.
  - `codex.js`: OpenAI Codex execution worker (`codex exec`).
  - `claude.js`: Anthropic Claude Code execution worker (`claude -p`).
  - `opencode.js`: OpenCode execution worker (`opencode -p`).
  - `commandcode.js`: CommandCode execution worker (`commandcode -p`).
  - `copilot.js`: GitHub Copilot CLI worker (`gh copilot -p`).
  - `cursor.js`: Cursor Agent worker (`cursor-agent -p`).
  - `gemini-cli.js`: Standalone Gemini CLI worker (`gemini -p`, distinct from `agy`).
  - `ollama.js`: Ollama local worker (`ollama run <model||"llama3.1">`).
  - `openai-api.js`, `anthropic-api.js`, `gemini-api.js`, `compat-api.js`: thin direct-API adapters over `executeApiTask`.
  - `generic.js`: Universal worker adapter for any arbitrary CLI execution tool.
  - `registry.js`: Open-ended worker provider registry, with `workerCapabilities()` (`canWrite`, `readsWorkspace`) used by the bridge to refuse impossible tasks.
- **MCP Bridge** ([`src/bridge/`](src/bridge/)):
  - `prompts.js`: Role prompts for `explore`, `implement`, `test`, `research`, and `review`.
  - `agy-runner.js`: Subprocess executor enforcing timeout, permission sandboxes, and transient socket reset recovery.
  - `server.js`: Standard MCP stdio server routing requests dynamically to the active worker provider, with optional per-call `provider` override, per-call read/write permission, file inlining for text-only workers, and `git apply` of approved previews.
- **Session Persistence & Projects** ([`src/data/sessions.js`](src/data/sessions.js)):
  - Project registry (`~/.kumo/projects.json`), multi-chat persistence, append-only turn logs (`~/.kumo/sessions/<hash>/`), and Markdown export.
- **Terminal UI & Utilities** ([`src/utils/`](src/utils/)):
  - `process.js`: Safe child-process execution preventing Node.js `[DEP0190]` security warnings.
  - `model-picker.js`: Interactive arrow-key navigation with atomic flicker-free redraw and provider-first selection.
  - `history.js`: Readline history manager with slash-command filtering and history clearing.
  - `spinner.js`: Non-blocking terminal thinking spinner with live elapsed second timer.

---

## Development & Testing

```powershell
npm test            # the suite
npm run lint        # ESLint
npm run typecheck   # tsc over JSDoc, strict for files with // @ts-check (all of src/core)
npm run check       # all three
```

Kumo needs Node 22 or later. The suite runs offline against stub CLIs and a sandboxed `KUMO_HOME`. It drives the real paths end to end: the MCP bridge over stdio (worker permissions per call, `git apply` of approved previews, refusals for text-only workers), the engine (`Session`) against scripted clients, a real bridge connected back to a real session over the named pipe (per-session settings, streamed output, approvals), the interactive REPL over pipes (saved transcripts), `kumo run` with fake clients, Claude Code's stream-json output from a recorded turn, and argument passing through real `cmd.exe` `.cmd` shims on Windows. Codex event fixtures in `tests/fixtures/codex-protocol.json` follow the app-server schema.

To also run the tests that use real CLIs and accounts (Codex rate limits, and a check of the fixtures against `codex app-server generate-json-schema`):

```powershell
$env:KUMO_LIVE_TESTS = "1"; npm test
```

CI runs lint and the type check once, and the suite on Windows and Linux with Node 22 and 24, with a coverage floor for `src/bridge`, `src/providers` and `src/core`. After upgrading Codex, refresh the vendored protocol types with `npm run refresh:codex-protocol`.
