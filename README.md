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
   - **Refactoring**: `"Refactor error handling in bridge/server.js with retries"`
   - **Testing & Debugging**: `"Run npm test and fix any failing edge cases"`

2. **Orchestrator Plans & Delegates**:
   - **ChatGPT 6 Astra** analyzes your prompt, formulates an execution plan, and calls Gemini worker tools (`gemini_explore`, `gemini_implement`, `gemini_test`, etc.) via the local MCP stdio bridge.

3. **Grunt Worker Executes**:
   - **Gemini 3.8 Flash** performs the heavy reading, editing, and test execution using its 1M token context window at high speed.
   - **Quota Preservation**: Codex never bloats its ChatGPT Plus quota reading large codebase files directly.

4. **Review & Summary**:
   - The orchestrator verifies changes, runs tests, and presents a clean report back to you.

---

## Model Configuration & Arrow-Key Navigation

Kumo provides dual-layer model configuration: an interactive arrow-key selector and direct CLI / in-session commands.

### 1. Interactive Model Picker (`/model` or `kumo model`)

Launch the arrow-key menu by running `kumo model` in your terminal or typing `/model` inside an active interactive session:

- **Arrow-Key Navigation**: Navigate options with `↑` / `↓`, press `Enter` to select, or press `Esc` / choose `Cancel` to return to your session without changes.
- **Contained Terminal Rendering**: Cursor recalculation guarantees that scrolling through choices never erases session history, banners, or tutorial prompts above the menu.
- **Configurable Areas**:
  - **Apply Preset Profile**: Rapidly switch between balanced, performance, speed, and test presets.
  - **Select Orchestrator Model**: Choose from available Codex models (`chatgpt-6-astra`, `gpt-5.6-luna`, `gpt-5.6-terra`, `chatgpt-5.6-sol`, `gpt-5.5`).
  - **Select Worker Model**: Choose from available Antigravity models (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`).
  - **Set Reasoning Effort**: Adjust reasoning levels independently for both the Orchestrator and Worker.

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
kumo model use default
kumo model use test

# Quick shorthand to set both orchestrator and worker
kumo model gpt-5.6-luna gemini-3.8-flash low
```

### 4. In-Session Slash Commands

When working inside an interactive Kumo session (`kumo ›`), manage models on the fly without exiting:

- `/model`: Opens the interactive arrow-key menu
- `/model <model>`: Switches orchestrator model (e.g. `/model luna`, `/model gpt-5.5`)
- `/model worker <model> [effort]`: Switches worker model and effort (e.g. `/model worker opus`, `/model worker gemini-3.8-flash high`)
- `/model use <preset>`: Applies a preset profile (e.g. `/model use pro`, `/model use test`)
- `/effort <level>`: Sets orchestrator reasoning effort (`low`, `medium`, `high`, `max`)
- `/effort worker <level>`: Sets worker reasoning effort (`low`, `medium`, `high`)
- `/status`: Checks live account rate limits, remaining quotas, and provider health
- `/clear`: Clears the screen and re-renders the header banner with active models
- `/exit` or `/quit`: Closes the session

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

The codebase implements a decoupled provider structure:
- **Orchestrators** ([`src/providers/orchestrators/`](file:///d:/Projects/Orchestrator/src/providers/orchestrators/)):
  - `codex.js`: OpenAI Codex CLI adapter with dynamic MCP bridge injection.
  - `registry.js`: Provider registry allowing additional orchestrator adapters.
- **Workers** ([`src/providers/workers/`](file:///d:/Projects/Orchestrator/src/providers/workers/)):
  - `gemini.js`: Google Gemini adapter backed by Antigravity / Gemini CLI.
  - `registry.js`: Worker registry supporting future agent execution engines.
- **MCP Bridge** ([`src/bridge/`](file:///d:/Projects/Orchestrator/src/bridge/)):
  - `prompts.js`: Role prompts for `explore`, `implement`, `test`, `research`, and `review`.
  - `agy-runner.js`: Subprocess executor enforcing timeout, permission sandboxes, and buffer management.
