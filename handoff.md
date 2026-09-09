# KUMO (雲) — Engineering Handoff

## 1. Project Overview

**KUMO** is a cross-provider CLI orchestrator pairing frontier reasoning models with high-speed execution workers. It runs on existing subscription logins without requiring third-party API keys:

- **Root Orchestrator**: **ChatGPT 6 Astra** (or **GPT-5.5** for low-cost testing) executed via the **Codex CLI** (`codex.exe`) on a ChatGPT Plus/Go subscription. Handles requirements scoping, architecture design, step decomposition, and final code reviews.
- **Execution Worker**: **Gemini 3.8 Flash** (or **Gemini 3.6 Flash** for testing) executed via the **Antigravity CLI** (`agy.exe`) on a Google AI Pro subscription. Handles read-only codebase exploration, file editing/refactoring, test writing, and technical research via a dynamic MCP stdio bridge.

---

## 2. Architecture & Components

```
┌─────────────────────────────────────────────────────────────┐
│                      KUMO CLI UI / REPL                     │
│               (Independent Interactive Session)              │
└──────────────┬───────────────────────────────┬──────────────┘
               │                               │
               ▼                               ▼
    ┌─────────────────────┐         ┌─────────────────────┐
    │  Codex App Server   │         │   Antigravity CLI   │
    │     (JSON-RPC)      │         │      (agy.exe)      │
    └──────────┬──────────┘         └──────────┬──────────┘
               │                               │
               └────────► [MCP Stdio Bridge] ◄─┘
                          bridge/server.js
```

### Key Modules:
- **`bin/kumo.js`**: Executable binary entry point registered in `package.json`.
- **`src/cli.js`**: Commander router dispatching interactive sessions, headless runs, model switching, status checks, and doctor diagnostics.
- **`src/commands/start.js`**: Independent interactive REPL. Renders Cloud Cumulus (雲) banner, runs background workers silently, manages live quota auto-refreshes (every 30s after prompt submission), and processes in-session commands (`/model`, `/effort`, `/status`, `/refresh`, `/clear`, `/exit`).
- **`src/commands/status.js`**: Queries live quotas and health for both Codex and Antigravity, formatting them with aligned 20-character labels and 14-block ASCII progress bars.
- **`src/commands/model.js`**: Inspects and switches models and reasoning levels for both Orchestrator and Worker, supporting presets and shorthand commands.
- **`src/utils/window-launcher.js`**: Spawns Kumo in a dedicated PowerShell window using `-NoProfile -NoExit -ExecutionPolicy Bypass` and closes the calling terminal.
- **`src/utils/quota-cache.js`**: Local disk cache (`~/.kumo/quota_cache.json`) enabling `<5ms` instant menu and banner rendering upon window launch.
- **`src/utils/ui.js`**: ANSI styling tokens, Cloud Cumulus (雲) banner, cyan-to-blue gradient rules (`brightCyan` → `cyan` → `brightBlue` → `blue`), standardized 14-block progress bars (`progressBar(percent, 14)`), and relative/calendar date formatters (`formatResetTime`, `formatIsoResetTime`).
- **`bridge/agy-runner.js`**: Low-level executor for `agy.exe`. Resolves binary path, manages timeouts, parses live tab-separated quotas via `agy -p /usage`, and sets `--dangerously-skip-permissions` with mode `accept-edits` or `plan`.
- **`bridge/server.js`**: MCP stdio bridge exposing 5 tools (`gemini_explore`, `gemini_implement`, `gemini_test`, `gemini_research`, `gemini_review`) to Codex. Forwards worker model and reasoning effort.
- **`src/config/settings.js`**: Global configuration stored in `~/.kumo/config.json`. Manages presets, custom model strings, and dual-provider reasoning efforts.

---

## 3. Presets & Dual-Provider Reasoning

Kumo supports reasoning effort configuration on **both** providers:
- **Orchestrator Reasoning**: `low`, `medium`, `high`, `max` (forwarded to Codex as `model_reasoning_effort`)
- **Worker Reasoning**: `low`, `medium`, `high` (forwarded to Antigravity as `--effort`)

### Built-in Presets:
| Preset | Orchestrator Model | Orchestrator Effort | Worker Model | Worker Effort | Target Usage |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`default`** | `chatgpt-6-astra` | `low` | `gemini-3.8-flash` | `medium` | Everyday development (ChatGPT Plus + Google AI Pro) |
| **`pro`** | `chatgpt-6-astra` | `medium` | `gemini-3.8-flash` | `high` | Complex tasks (ChatGPT Pro higher rate limits) |
| **`speed`** | `chatgpt-5.6-sol` | `low` | `gemini-3.8-flash` | `low` | Rapid iteration and fast turnaround |
| **`gemini-3.7`** | `chatgpt-6-astra` | `low` | `gemini-3.7-flash` | `medium` | Fallback worker compatibility |
| **`test`** | `gpt-5.5` | `low` | `gemini-3.6-flash` | `low` | Low-quota verification (ChatGPT Go tier safe) |

---

## 4. CLI & Interactive Commands Reference

### CLI Commands:
```powershell
# Interactive Session (opens in dedicated window)
kumo
kumo --here                               # Run in current terminal without spawning window

# Live Account Quotas & Rate Limits
kumo status                               # Also: kumo quota, kumo usage

# Model & Reasoning Configuration
kumo model                                # Display current setup, presets, and commands
kumo model <model>                        # Set orchestrator model (e.g. kumo model gpt-5.5)
kumo model orchestrator <model> [effort]  # Set orchestrator model and effort
kumo model worker <model> [effort]        # Set worker model and effort
kumo model use <preset>                   # Apply preset (e.g. kumo model use test)

kumo effort <low|medium|high|max>         # Set orchestrator reasoning effort
kumo effort worker <low|medium|high>      # Set worker reasoning effort

# Diagnostics & Rules Initialization
kumo doctor                               # Verify binaries, logins, and MCP bridge
kumo init                                 # Scaffold AGENTS.md & GEMINI.md in workspace
kumo banner                               # Display Cloud Cumulus banner
```

### In-Session REPL Commands:
```text
/help                                     Show interactive help
/status                                   Refresh and show live dual-provider quotas
/model                                    Show active model configuration
/model <model>                            Switch orchestrator model on the fly
/model worker <model> [effort]            Switch worker model and reasoning effort
/effort <low|medium|high|max>             Change orchestrator reasoning effort
/effort worker <low|medium|high>          Change worker reasoning effort
/clear                                    Clear screen and redraw Cloud Cumulus banner
/refresh                                  Re-query live account rate limits
/exit                                     Cleanly quit session
```

---

## 5. How to Actually Start and Do Work with KUMO

KUMO provides both an **interactive REPL session** and a **headless one-shot execution** mode:

### 1. Launching a Session
From your target project workspace directory:
```powershell
# Open dedicated interactive session (spawns in independent window)
kumo

# Or run directly inside the current terminal
kumo --here

# Or execute a single headless prompt across providers without launching the UI
kumo run "Explore src/ and summarize the architecture"
```

### 2. The Core Orchestration Workflow
When inside the session (`kumo ›`):
1. **Enter High-Level Tasks**: You don't need to manually read or paste code. Simply describe your goal:
   - Feature additions: *"Implement JWT authentication in src/auth.js and write unit tests"*
   - Architectural exploration: *"Explore src/ and document data flow between providers"*
   - Refactoring: *"Refactor bridge error handling to support automatic reconnection"*
   - Bug fixing: *"Run tests, locate why status bars clip, and fix the root cause"*
2. **Orchestrator Plans & Delegates**:
   - **ChatGPT 6 Astra** (or your selected orchestrator) evaluates requirements, decomposes steps, and issues targeted commands to the worker via MCP stdio bridge tools (`gemini_explore`, `gemini_implement`, `gemini_test`, `gemini_research`, `gemini_review`).
3. **Grunt Worker Executes**:
   - **Gemini 3.8 Flash** executes the heavy file inspection, refactoring, and test execution using its 1M context window and fast inference speed.
   - **Quota Preservation**: Codex never bloats its ChatGPT Plus quota reading large codebase files directly.
4. **Review & Verification**:
   - The orchestrator inspects the generated diffs, verifies test results, and presents a concise summary to the user.

### 3. Model & Quota Management
- Type `/model` at any time to open the **interactive arrow-key model picker** (`↑`/`↓`, `Enter`, `Esc`).
- Type `/effort <low|medium|high|max>` to adjust reasoning depth on the fly.
- Type `/status` or `/refresh` to monitor live rate limits and 14-block gradient usage bars.

---

## 6. Visual Display & Layout Standards

All metadata labels and progress bars adhere to strict layout standards:
- **Banner**: Refined Cloud Cumulus ASCII cluster with `KUMO (雲) v1.0.0` title badge.
- **Window Title**: Set to `KUMO — 雲` using em dash (`—`) and kanji (`雲`).
- **Coloring Scheme**: Pure luminous blueish gradient palette (`brightCyan` → `cyan` → `brightBlue` → `skyBlue`). Dark navy blue (`\x1b[34m`) and over-dimmed text are completely eliminated for maximum contrast across all terminal backgrounds.
- **Labels**: Standard 24-character width (`.padEnd(24)`):
  - `Workspace:` (`brightCyan`)
  - `Orchestrator:` (`brightCyan`)
  - `Worker:` (`cyan`)
  - `Orchestrator Monthly:` / `Orchestrator Weekly:` (`cyan`)
  - `Worker Weekly:` (`brightBlue`)
  - `Worker 5-Hour:` (`brightBlue`, omitted if no 5-hour limit exists)
- **Model Reasoning Suffix**: Attached directly to model names with a hyphen (`gpt-5.6-luna-low`, `gemini-3.8-flash-medium`).
- **Subscription Tags**: Enclosed in parentheses beside the model (`(ChatGPT Plus)`, `(Google AI Pro)`).
- **Bracket-Free Quotas**: Clean progress bars without model or subscription tags in brackets.
- **Active Model Scoping**: Quotas strictly display only the metrics for the models actively in use. Unselected model pools (e.g. Claude/GPT pool when using Gemini) are completely suppressed.
- **Quota Bars**: 14-block ASCII progress bar with filled blocks smoothly transitioning along the **blueish gradient** (`progressBar(percent, 14)`).
- **Reset Timestamps**: Display both relative countdown and local calendar date:
  `in 6d 22h (Sep 17, 03:53 AM)`

---

## 7. Verification & Automated Tests

Run the test suite from the repository root:
```powershell
node --test tests/*.test.js
```

All 24 tests pass:
- `tests/bridge.test.js`: Validates MCP stdio bridge initialization and tool discovery.
- `tests/cli.test.js`: Validates CLI command parsing, binary detection, and Codex invocation parameters.
- `tests/cloud-banners.test.js`: Validates Cloud Cumulus banner rendering, 14-block progress bars, and reset formatters.
- `tests/codex-client.test.js`: Validates Codex JSON-RPC app client protocol and rate limits querying.
- `tests/model.test.js`: Validates presets (including `test`), `effortCommand` for orchestrator and worker, and model switching.
- `tests/model-picker-and-gradient.test.js`: Validates blueish gradient progress bar colors, model discovery (`getAgyModels`, `getOrchestratorModels`), and active model scoping.

---

## 8. Repository Info
- **Repository**: [https://github.com/ainere/Kumo.git](https://github.com/ainere/Kumo.git)
- **Branch**: `main`
