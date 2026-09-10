# KUMO — Cross-Provider AI Orchestration Harness

```text
         .---.                    
      .-(     ).    .---.           KUMO (雲) v1.0.0
    .(          ).-(     ).         Cross-Provider AI Orchestrator
   (____.__.__.____)(____)          Frontier Reasoning ◄───[MCP]───► High-Speed Execution
```

**Kumo** is a modular CLI application that pairs frontier reasoning models with high-throughput execution workers across independent AI ecosystems.

By default, it coordinates **ChatGPT 6 Astra** (via Codex CLI on ChatGPT Plus) as the root orchestrator and **Gemini 3.8 Flash** (via Antigravity / Gemini CLI on Google AI Pro) as the high-throughput worker — utilizing your existing consumer subscriptions with **zero separate API keys**.

The provider architecture is designed for multi-provider extensibility, including future support for Anthropic Claude, OpenAI, and Google workflows.

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
       ┌─────────────────────────┴─────────────────────────┐
       ▼                                                   ▼
┌───────────────────────────┐               ┌───────────────────────────┐
│   Orchestrator Provider   │               │      Worker Provider      │
│   (Default: OpenAI Codex  │               │  (Default: Google Gemini  │
│     ChatGPT 6 Astra Low)  │ ◄─── [MCP] ──►│     Gemini 3.8 Flash)     │
│   • Task decomposition    │               │   • File exploration      │
│   • Architectural design  │               │   • Code implementation   │
│   • Cross-model review    │               │   • Test generation & runs│
└───────────────────────────┘               └───────────────────────────┘
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
| **Explorer** | `worker_explore` *(alias: `gemini_explore`)* | Read-only | Finds files & symbols, traces call flows. Returns: 1) Relevant files/symbols, 2) Flow, 3) Constraints/risks, 4) Recommended implementation surface. |
| **Worker** | `worker_implement` *(alias: `gemini_implement`)* | Workspace-write | Executes bounded changes. If scope is ambiguous, stops and escalates. Returns: 1) What changed, 2) Files modified, 3) Validation run, 4) Remaining risks. |
| **Tester** | `worker_test` *(alias: `gemini_test`)* | Workspace-write | Runs targeted tests, reproduces failures. Never rewrites production code to pass tests. Returns: 1) Commands run, 2) Pass/fail, 3) Output, 4) Gaps, 5) Next action. |
| **Researcher** | `worker_research` *(alias: `gemini_research`)* | Read-only | Verifies facts against primary documentation. Returns: 1) Verified answer, 2) Version assumptions, 3) Citations, 4) Uncertainties. |
| **Reviewer** | `worker_review` *(alias: `gemini_review`)* | Read-only | Pre-flight check before synthesis. Prioritizes bugs, security, regressions, and data integrity over style nitpicks. |

---

## Knowledge & Documentation Integrity

1. **Graphify (`graphify-out/`)**:
   - Code exploration always consults `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`) first to map god nodes, call hierarchies, and architectural clusters.
2. **Obsidian Knowledge Vault**:
   - Lasting architectural decisions, verified multi-step procedures, and project handoffs are recorded in the shared Obsidian workspace (`C:\Users\xenob\Documents\Obsidian\Agent-Workspace`).
3. **Immediate README Maintenance**:
   - **Whenever a major change is made** (features, commands, configuration, or architecture), **`README.md` must be updated immediately** to preserve documentation synchronization.

---

## Features & Capabilities

- **Zero API Keys**: Connects directly to your logged-in consumer subscriptions (**ChatGPT Plus / Pro** via Codex CLI and **Google AI Pro** via Antigravity / Gemini CLI).
- **Dual-Provider Architecture**: Frontier reasoning orchestrator breaks down complex architecture and dispatches bounded execution tasks to high-throughput workers via local MCP stdio bridge.
- **Dynamic Model Tracking & Role Synchronization**: Changing active models via `/model` or presets immediately updates worker prompts and subagent instructions (`.codex/agents/reviewer.toml`), ensuring each role dynamically reflects which model is operating.
- **Multi-Chat Session Persistence**: Persistent local conversation index and turn logging under `~/.kumo/sessions/` with instant switching (`/chats`) and Markdown export (`/save`).
- **Global Project Registry**: Automatically tracks workspaces with quick switching (`/projects` or `/cd <path>`).
- **Provider-First Model Picker**: Arrow-key dialog (`/model` or `kumo model`) supporting Codex (OpenAI) and Antigravity (Google / Anthropic) with atomic flicker-free redraw and back navigation.
- **Live Multi-Provider Quota Meters**: Real-time 5-hour, weekly, and monthly quota progress bars that dynamically adapt based on active orchestrator and worker providers.
- **Prompt History & Smart Filtering**: Persistent command history (`~/.kumo/history.txt`) with automatic slash-command filtering (Up Arrow only cycles actual prompts).
- **Context-Aware Smart Suggestions**: Project type detection (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`) with inline recommended prompt actions.
- **Live Thinking Spinner & Timer**: Non-blocking animated terminal spinner with elapsed second timer and clean Ctrl+C task interruption.

---

## Model Configuration & Arrow-Key Navigation

Kumo provides dual-layer model configuration: an interactive arrow-key selector and direct CLI / in-session commands.

### 1. Interactive Model Picker (`/model` or `kumo model`)

Launch the arrow-key menu by running `kumo model` in your terminal or typing `/model` inside an active interactive session:

- **Arrow-Key Navigation**: Navigate options with `↑` / `↓`, jump with `Home` / `End`, page with `PageUp` / `PageDown`, press `Enter` to select, or press `Left Arrow` / `Esc` to go back.
- **Provider-First Model Selection**: Choose between **Codex (OpenAI)** and **Antigravity (Google / Anthropic)** for both Orchestrator and Worker models.
- **Atomic Flicker-Free Redraw**: Uses single-write ANSI buffering so navigating choices never scrolls the terminal or pollutes session history.
- **Dynamic Quota Synchronization**: The startup header and `/status` command automatically adapt their quota progress bars to reflect the provider chosen for each role.

### 2. Built-in Presets

| Preset | Orchestrator Model | Orchestrator Effort | Worker Model | Worker Effort | Target Usage |
|---|---|---|---|---|---|
| `default` | `chatgpt-6-astra` | `low` | `gemini-3.8-flash` | `medium` | Everyday development (ChatGPT Plus + Google AI Pro) |
| `pro` | `chatgpt-6-astra` | `medium` | `gemini-3.8-flash` | `high` | Complex architecture & deep reasoning (ChatGPT Pro) |
| `speed` | `chatgpt-5.6-sol` | `low` | `gemini-3.8-flash` | `low` | High-speed iteration and rapid turnaround |
| `gemini-3.7` | `chatgpt-6-astra` | `low` | `gemini-3.7-flash` | `medium` | Fallback worker compatibility |
| `test` | `gpt-5.5` | `low` | `gemini-3.6-flash` | `low` | Lowest quota verification (ChatGPT Go tier safe) |

### 3. CLI Commands

Configure models and reasoning efforts directly from your shell:

```powershell
# Open interactive arrow-key selector
kumo model

# View full model configuration, active providers, and available presets
kumo model list

# Set orchestrator model and optional reasoning effort (supports aliases like luna, sol, terra, astra)
kumo model orchestrator chatgpt-6-astra low
kumo model orchestrator gpt-5.6-luna medium

# Set worker model and optional reasoning effort (supports aliases like opus, sonnet, flash)
kumo model worker gemini-3.8-flash medium
kumo model worker claude-opus-4-6-thinking high

# Set orchestrator reasoning effort independently (low, medium, high, max)
kumo effort low
kumo effort medium

# Set worker reasoning effort independently (low, medium, high)
kumo effort worker low
kumo effort worker medium

# Apply a preset profile
kumo preset default
kumo model use pro
kumo model use test

# Quick shorthand to set both orchestrator and worker
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
- `/refresh`: Re-fetches live quotas immediately from Codex and Antigravity.
- `/history`: Displays recent prompt query history.
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
| `kumo -d <path>` | Launch interactive session in a specified directory |
| `kumo run "<prompt>"` | Execute a single task non-interactively across providers |
| `kumo status` | View live account rate limits, usage quotas, and provider health |
| `kumo model` | Open interactive arrow-key selector (`/model` in session) |
| `kumo model list` | Print complete list of available models and presets |
| `kumo model orchestrator <model> [effort]` | Configure orchestrator model and optional reasoning effort |
| `kumo model worker <model> [effort]` | Configure worker model and optional reasoning effort |
| `kumo effort <level>` | Set orchestrator reasoning effort (`low`, `medium`, `high`, `max`) |
| `kumo effort worker <level>` | Set worker reasoning effort (`low`, `medium`, `high`) |
| `kumo model use <preset>` | Apply configuration preset (`default`, `pro`, `speed`, `gemini-3.7`, `test`) |
| `kumo doctor` | Perform diagnostic check on system environment and logins |
| `kumo config list` | View global configuration keys and values (`~/.kumo/config.json`) |
| `kumo config set <key> <val>` | Update a specific configuration property |
| `kumo config reset` | Reset global configuration to defaults |
| `kumo init` | (Optional) Initialize repository rule files (`AGENTS.md`, `GEMINI.md`) |

---

## Architecture & Extensibility

The codebase implements a decoupled provider and data persistence structure:
- **Orchestrators** ([`src/providers/orchestrators/`](src/providers/orchestrators/)):
  - `codex.js`: OpenAI Codex CLI adapter with dynamic MCP bridge injection.
  - `codex-client.js`: Hidden-process Codex app client supporting streaming turns and rate-limit extraction.
  - `registry.js`: Provider registry allowing additional orchestrator adapters.
- **Workers** ([`src/providers/workers/`](src/providers/workers/)):
  - `gemini.js`: Google Gemini adapter backed by Antigravity / Gemini CLI.
  - `registry.js`: Worker registry supporting future agent execution engines.
- **MCP Bridge** ([`src/bridge/`](src/bridge/)):
  - `prompts.js`: Role prompts for `explore`, `implement`, `test`, `research`, and `review`.
  - `agy-runner.js`: Subprocess executor enforcing timeout, permission sandboxes, and buffer management.
  - `server.js`: Standard MCP stdio server with dynamic `--workspace` targeting.
- **Session Persistence & Projects** ([`src/data/sessions.js`](src/data/sessions.js)):
  - Project registry (`~/.kumo/projects.json`), multi-chat persistence, append-only turn logs (`~/.kumo/sessions/<hash>/`), and Markdown export.
- **Terminal UI & Utilities** ([`src/utils/`](src/utils/)):
  - `model-picker.js`: Interactive arrow-key navigation with atomic flicker-free redraw and provider-first selection.
  - `history.js`: Readline history manager with slash-command filtering and history clearing.
  - `spinner.js`: Non-blocking terminal thinking spinner with live elapsed second timer.
