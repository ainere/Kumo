# KUMO — Cross-Provider AI Orchestration Harness

```text
█  █  █   █  █   █   ███ 
█ █   █   █  ██ ██  █   █   KUMO v1.0.0
██    █   █  █ █ █  █   █   Cross-Provider AI Orchestrator
█ █   █   █  █   █  █   █
█  █   ███   █   █   ███ 
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

## Quick Start & Verification

### 1. Pre-flight Diagnostics
Run `kumo doctor` to verify environment prerequisites and subscription authentication:

```powershell
kumo doctor
```

Output:
```text
█  █  █   █  █   █   ███ 
█ █   █   █  ██ ██  █   █   KUMO v1.0.0
██    █   █  █ █ █  █   █   Cross-Provider AI Orchestrator
█ █   █   █  █   █  █   █
█  █   ███   █   █   ███ 
────────────────────────────────────────────────────────────────
  System & Subscription Diagnostics
────────────────────────────────────────────────────────────────

  [OK] Node.js Runtime            v25.9.0 (Supported)
  [OK] Codex CLI (OpenAI)         Installed (codex-cli 0.153.4)
  [OK] Gemini CLI (Google)        Installed 'gemini' (0.59.0)
  [OK] MCP Bridge Server          Bridge initialized successfully with 5 tools registered.

  Global Config:  C:\Users\username\.kumo\config.json
    • orchestratorProvider: "codex"
    • orchestratorModel: "chatgpt-6-astra"
    • reasoningEffort: "low"
    • workerProvider: "gemini"
    • workerModel: "gemini-3.8-flash"

────────────────────────────────────────────────────────────────
  [OK] All systems operational. Ready to run 'kumo'.
────────────────────────────────────────────────────────────────
```

### 2. Launch Interactive Orchestration

```powershell
cd d:\Projects\TargetRepository
kumo
```

- Dynamically attaches to the target workspace directory.
- Starts the native terminal session with streaming output, diff inspection, and tool approvals.
- Registers Gemini worker tools (`gemini_explore`, `gemini_implement`, `gemini_test`, `gemini_research`, `gemini_review`) via standard Model Context Protocol (MCP).
- Requires no temporary files or workspace-polluting artifacts.

---

## Model Configuration (`kumo model`)

Inspect or change the orchestrator or worker models without modifying project files:

```powershell
# Inspect active models and available presets
kumo model

# Set orchestrator model and reasoning effort
kumo model orchestrator chatgpt-6-astra low
kumo model orchestrator chatgpt-5.6-sol low

# Set worker model
kumo model worker gemini-3.8-flash
kumo model worker gemini-3.7-flash

# Apply a preset profile
kumo model use pro       # Astra Medium + Gemini 3.8 Flash
kumo model use speed     # Sol + Gemini 3.8 Flash
kumo model use default   # Astra Low + Gemini 3.8 Flash (ChatGPT Plus quota-optimized)
```

---

## CLI Reference

| Command | Description |
|---|---|
| `kumo` | Launch interactive session in the current directory |
| `kumo -d <path>` | Launch interactive session in a specified directory |
| `kumo run "<prompt>"` | Execute a single task non-interactively across providers |
| `kumo model` | View active models, providers, and presets |
| `kumo model orchestrator <model> [effort]` | Configure orchestrator model |
| `kumo model worker <model>` | Configure worker model |
| `kumo model use <preset>` | Apply predefined configuration preset (`default`, `pro`, `speed`, `gemini-3.7`) |
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
