# KUMO — Cross-Provider AI Orchestration Harness

```text
         .---.                    
      .-(     ).    .---.           KUMO (雲) v1.0.0
    .(          ).-(     ).         Cross-Provider AI Orchestrator
   (____.__.__.____)(____)          Frontier Reasoning ◄───[MCP]───► High-Speed Execution
```

**Kumo** is a modular CLI application that pairs frontier reasoning models with high-throughput execution workers across independent AI ecosystems.

It coordinates frontier models across **Anthropic Claude** (Claude Opus 4.6 Thinking, Claude Sonnet 4.6), **OpenAI ChatGPT / Codex** (ChatGPT 6 Astra, Sol, Terra, Luna, GPT-5.5), and **Google Gemini** (Gemini 3.8 / 3.7 / 3.6 Flash, Gemini 3.1 Pro) — allowing **any of 13 providers to serve as Orchestrator or Worker** (e.g. Claude Opus Orchestrator + Codex Worker, or Codex Orchestrator + Gemini Worker) running on your existing subscriptions by default, with optional direct API usage (metered env-var keys, never stored).

---

## Architecture

```text
                          Global invocation:
                               $ kumo
                                 │
                                 ▼
                  ┌─────────────────────────────┐
                  │          KUMO CLI           │
                  │   • Dynamic Workspace CWD   │
                  │   • Model / Preset Manager  │
                  │   • Provider Dispatcher     │
                  └──────────────┬──────────────┘
                                 │
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
   - The **Orchestrator** (default: ChatGPT 6 Astra) analyzes your prompt, formulates an execution plan, and calls worker tools (`worker_explore`, `worker_implement`, `worker_test`, etc.) via the local MCP stdio bridge.

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
| `diff-review` | Two-phase programmatic preview gate: Phase 1 generates a proposed unified diff preview without modifying files (`confirm: false`). Phase 2 applies changes only when the *calling orchestrator model* programmatically re-invokes with `confirm: true` and a matching `previewId`, backed by diff-fidelity verification. | Multi-turn programmatic validation, headless CI pipelines. |
| `interactive` | Two-phase human approval gate: generates a proposed unified diff preview (Phase 1) and prompts a human operator on the interactive TTY in the `kumo` REPL (`Apply changes? [y/N/d]`) before changes apply (Phase 2). In non-TTY environments, behaves identically to `diff-review`. | Critical client work, production codebases, high-stakes manual oversight. |

---

## Features & Capabilities

- **Subscriptions by Default**: Connects directly to your logged-in consumer subscriptions across 9 CLI providers (`codex, antigravity, claude, opencode, commandcode, copilot, cursor, gemini-cli, ollama`) — zero keys on disk. Kumo never persists your keys. Only the API keys relevant to the selected provider are forwarded to the provider CLIs Kumo launches; other secret-looking environment variables are stripped from the child environment.
- **Direct API (optional, env keys never stored)**: `openai-api (OPENAI_API_KEY), anthropic-api (ANTHROPIC_API_KEY), gemini-api (GEMINI_API_KEY), compat-api (COMPAT_BASE_URL + optional COMPAT_API_KEY)` — per-role or per-call (`provider: "anthropic-api"`), mixed with subscriptions; non-secret base-URL overrides via `kumo config set <name>BaseUrl`.
- **Multi-Provider Architecture**: Frontier reasoning orchestrator breaks down complex architecture and dispatches bounded execution tasks to high-throughput workers via local MCP stdio bridge.
- **Dynamic Model Tracking & Role Synchronization**: Changing active models via `/model` or presets immediately updates worker prompts and subagent instructions (`.codex/agents/reviewer.toml`), ensuring each role dynamically reflects which model is operating.
- **Multi-Chat Session Persistence**: Persistent local conversation index and turn logging under `~/.kumo/sessions/` with instant switching (`/chats`) and Markdown export (`/save`).
- **Global Project Registry**: Automatically tracks workspaces with quick switching (`/projects` or `/cd <path>`).
- **Provider-First Model Picker**: Arrow-key dialog (`/model` or `kumo model`) grouping Subscription CLIs and Direct API providers (see Model Configuration below) with atomic flicker-free redraw and back navigation.
- **Live Multi-Provider Quota Meters**: Real-time 5-hour, weekly, and monthly quota progress bars that dynamically adapt based on active orchestrator and worker providers.
- **Prompt History & Smart Filtering**: Persistent command history (`~/.kumo/history.txt`) with automatic slash-command filtering (Up Arrow only cycles actual prompts).
- **Context-Aware Smart Suggestions**: Project type detection (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`) with inline recommended prompt actions.
- **Live Thinking Spinner & Timer**: Non-blocking animated terminal spinner with elapsed second timer and clean Ctrl+C task interruption.
- **Live Agent Visibility & Focus Switching**: Real-time worker output streaming with side-channel log tailing, model & effort indicators (`gemini-3.8-flash, effort: medium`), dimmed reasoning deltas, ring-buffered streams, and `Tab` key stream focus switching between Orchestrator and active Worker subprocesses.

---

## Model Configuration & Arrow-Key Navigation

Kumo provides dual-layer model configuration: an interactive arrow-key selector and direct CLI / in-session commands.

### 1. Interactive Model Picker (`/model` or `kumo model`)

Launch the arrow-key menu by running `kumo model` in your terminal or typing `/model` inside an active interactive session:

- **Arrow-Key Navigation**: Navigate options with `↑` / `↓`, jump with `Home` / `End`, page with `PageUp` / `PageDown`, press `Enter` to select, or press `Left Arrow` / `Esc` to go back.
- **Provider-First Model Picker**: Arrow-key dialog (`/model` or `kumo model`) grouping Subscription CLIs (`codex, antigravity, claude, opencode, commandcode, copilot, cursor, gemini-cli, ollama`) and Direct API (`openai-api, anthropic-api, gemini-api, compat-api` — env keys, never stored) with atomic flicker-free redraw and back navigation.
- **Dynamic Quota Synchronization**: The startup header and `/status` command automatically adapt their quota progress bars to reflect the provider chosen for each role.

### 2. Built-in Presets

| Preset | Orchestrator Model | Orchestrator Effort | Worker Model | Worker Effort | Target Usage |
|---|---|---|---|---|---|
| `default` | `chatgpt-6-astra` | `low` | `gemini-3.8-flash` | `medium` | Everyday development (ChatGPT Plus + Google AI Pro) |
| `pro` | `chatgpt-6-astra` | `medium` | `gemini-3.8-flash` | `high` | Complex architecture & deep reasoning (ChatGPT Pro) |
| `speed` | `chatgpt-5.6-sol` | `low` | `gemini-3.8-flash` | `low` | High-speed iteration and rapid turnaround |
| `opus-astra` | `claude-opus-4-6-thinking` | `high` | `chatgpt-6-astra` | `low` | Inverted harness: Claude Opus Orchestrator + Codex Astra Worker |
| `opus-flash` | `claude-opus-4-6-thinking` | `high` | `gemini-3.8-flash` | `medium` | Frontier reasoning Orchestrator (Opus) + high-speed Worker (Gemini) |
| `gemini-3.7` | `chatgpt-6-astra` | `low` | `gemini-3.7-flash` | `medium` | Fallback worker compatibility |
| `test` | `gpt-5.5` | `low` | `gemini-3.6-flash` | `low` | Lowest quota verification (ChatGPT Go tier safe) |

### 3. CLI Commands

Configure models, reasoning efforts, and providers directly from your shell:

```powershell
# Open interactive arrow-key selector
kumo model

# View full model configuration, active providers, and available presets
kumo model list

# Set orchestrator model, optional effort, and optional provider
# (auto-detects provider: e.g. claude-opus-4-6-thinking -> antigravity, chatgpt-6-astra -> codex)
kumo model orchestrator claude-opus-4-6-thinking
kumo model orchestrator chatgpt-6-astra low codex
kumo model orchestrator gpt-5.6-luna medium

# Set worker model, optional effort, and optional provider
kumo model worker gemini-3.8-flash medium
kumo model worker chatgpt-6-astra low codex
kumo model worker claude-opus-4-6-thinking

# Direct API per-role (env keys only, never stored)
kumo model worker gpt-4o-mini low openai-api
kumo model orchestrator claude-opus-4-6 high anthropic-api

# Set orchestrator reasoning effort independently (low, medium, high, max)
kumo effort medium

# Set worker reasoning effort independently (low, medium, high)
kumo effort worker low
kumo effort worker medium

# Apply a preset profile
kumo model use default
kumo model use opus-astra
kumo model use opus-flash
kumo model use pro
kumo model use test

# Quick shorthand to set both orchestrator and worker
kumo model claude-opus-4-6-thinking gemini-3.8-flash
kumo model gpt-5.6-luna gemini-3.8-flash low
```

### 4. In-Session Slash Commands

Inside an interactive Kumo session (`kumo ›`), manage sessions, workspaces, models, quotas, and history without exiting:

#### Session & Workspaces
- `/new`: Start a fresh conversation thread in the current workspace.
- `/chats`: Interactive arrow-key menu to browse and switch previous conversations.
- `/projects`: Interactive arrow-key menu to browse and switch registered project workspaces.
- `/cd <path>`: Switch active workspace directory on the fly.
- `/rename <title>`: Rename the active conversation thread.
- `/save [file]`: Export conversation transcript to a Markdown document.

#### Models & Reasoning
- `/model`: Opens the interactive arrow-key model & provider picker.
- `/model <name>`: Quick-switches orchestrator model (e.g. `/model astra`, `/model sol`, `/model gpt-5.5`).
- `/model worker <name> [effort]`: Quick-switches worker model and effort (e.g. `/model worker opus`, `/model worker flash high`).
- `/preset [name]`: Applies a configuration preset (e.g. `/preset pro`, `/preset speed`) or lists available presets.
- `/effort <level>`: Sets orchestrator reasoning effort (`low`, `medium`, `high`, `max`).
- `/effort worker <level>`: Sets worker reasoning effort (`low`, `medium`, `high`).

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
| `kumo` | Launch interactive session in dedicated window |
| `kumo --here` | Launch interactive session directly in current terminal |
| `kumo -d, --dir <path>` | Launch interactive session in a specified directory |
| `kumo start [-d, --dir <path>] [--here]` | Start an interactive orchestration session in the target workspace |
| `kumo run "<prompt>" [-d, --dir <path>]` | Execute a single task non-interactively across providers |
| `kumo status [-d, --dir <path>]` | View live account rate limits, usage quotas, and provider health |
| `kumo quota [-d, --dir <path>]` | Display live orchestrator and worker quotas (alias for `status`) |
| `kumo usage [-d, --dir <path>]` | Display live orchestrator and worker quotas (alias for `status`) |
| `kumo model` | Open interactive arrow-key selector (`/model` in session) |
| `kumo model list` | Print complete list of available models and presets |
| `kumo model orchestrator <model> [effort] [provider]` | Configure orchestrator model, effort, and explicit provider (13 ids) |
| `kumo model worker <model> [effort] [provider]` | Configure worker model, effort, and explicit provider (13 ids) |
| `kumo model use <preset>` | Apply configuration preset (`default`, `pro`, `speed`, `opus-astra`, `opus-flash`, `gemini-3.7`, `test`) |
| `kumo effort <level>` | Set orchestrator reasoning effort (`low`, `medium`, `high`, `max`) |
| `kumo effort worker <level>` | Set worker reasoning effort (`low`, `medium`, `high`) |
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
| `kumo init [-d, --dir <path>]` | (Optional) Initialize repository rule files (`AGENTS.md`, `GEMINI.md`) |
| `kumo init --dry-run` | Preview rule files (`AGENTS.md`, `GEMINI.md`) without writing to disk |
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
| `KUMO_NO_SYNC` | `src/config/sync.js` | Set to `1` to disable provider config synchronization (`syncAgentConfigs` no-op) |
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
| `OPENAI_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `openai-api` provider |
| `ANTHROPIC_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `anthropic-api` provider |
| `GEMINI_BASE_URL` / `GOOGLE_GENERATIVE_AI_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `gemini-api` provider |

---

## Architecture & Extensibility

The codebase implements a decoupled, unhardcoded provider and data persistence structure:
- **Orchestrators** ([`src/providers/orchestrators/`](src/providers/orchestrators/)):
  - `codex-client.js`: OpenAI Codex app-server client supporting streaming turns and live rate limits.
  - `agy-client.js`: Google Antigravity / Gemini CLI client supporting stream-json turns.
  - `claude-client.js`: Anthropic Claude Code CLI client supporting print mode turns.
  - `opencode-client.js`: OpenCode CLI client.
  - `commandcode-client.js`: CommandCode CLI client.
  - `copilot-client.js`: GitHub Copilot CLI client (`gh copilot`).
  - `cursor-client.js`: Cursor Agent CLI client (`cursor-agent`).
  - `gemini-cli-client.js`: Standalone Gemini CLI client (`gemini`, distinct from `agy`).
  - `ollama-client.js`: Ollama local runner client (`ollama run <model>`).
  - `generic-client.js`: Universal CLI orchestrator adapter that can drive any arbitrary AI CLI tool without hardcoding.
  - `registry.js`: Open-ended orchestrator provider registry and factory (13 providers incl. direct APIs).
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
  - `registry.js`: Open-ended worker provider registry.
- **MCP Bridge** ([`src/bridge/`](src/bridge/)):
  - `prompts.js`: Role prompts for `explore`, `implement`, `test`, `research`, and `review`.
  - `agy-runner.js`: Subprocess executor enforcing timeout, permission sandboxes, and transient socket reset recovery.
  - `server.js`: Standard MCP stdio server routing requests dynamically to the active worker provider, with optional per-call `provider` override.
- **Session Persistence & Projects** ([`src/data/sessions.js`](src/data/sessions.js)):
  - Project registry (`~/.kumo/projects.json`), multi-chat persistence, append-only turn logs (`~/.kumo/sessions/<hash>/`), and Markdown export.
- **Terminal UI & Utilities** ([`src/utils/`](src/utils/)):
  - `process.js`: Safe child-process execution preventing Node.js `[DEP0190]` security warnings.
  - `model-picker.js`: Interactive arrow-key navigation with atomic flicker-free redraw and provider-first selection.
  - `history.js`: Readline history manager with slash-command filtering and history clearing.
  - `spinner.js`: Non-blocking terminal thinking spinner with live elapsed second timer.
