# Roles and Models

The lead, the worker roles, how to give each role its own model, presets, and the model catalog. Back to the [README](../README.md).

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

### Worker Roles
The lead is the orchestrator. Every other role is one bridge tool, and each can run on its own model, picked from any subscription you are logged in to:

| Role | Tool | Permissions | Purpose & Schema |
|---|---|---|---|
| **scout** | `worker_explore` | Read-only | Finds files & symbols, traces call flows. Returns: 1) Relevant files/symbols, 2) Flow, 3) Constraints/risks, 4) Recommended implementation surface. |
| **builder** | `worker_implement` | Workspace-write | Executes bounded changes. If scope is ambiguous, stops and escalates. Returns: 1) What changed, 2) Files modified, 3) Validation run, 4) Remaining risks. |
| **tester** | `worker_test` | Workspace-write | Runs targeted tests, reproduces failures. Never rewrites production code to pass tests. Returns: 1) Commands run, 2) Pass/fail, 3) Output, 4) Gaps, 5) Next action. |
| **researcher** | `worker_research` | Read-only | Verifies facts against primary documentation. Returns: 1) Verified answer, 2) Version assumptions, 3) Citations, 4) Uncertainties. |
| **reviewer** | `worker_review` | Read-only | Pre-flight check before synthesis. Prioritizes bugs, security, regressions, and data integrity over style nitpicks. |
| **designer** | `worker_design` | Workspace-write | Owns the visual and interaction design and implements it: UI/UX, layout, typography, motion. Returns: 1) Design decisions, 2) Files modified, 3) How it was checked, 4) Open questions for the owner. |
| **custom** | `worker_<id>` | Read or write, as defined | Your own roles (`kumo role add`), each with its own instructions, description and model. |

### Assigning Models to Roles
A role with no assignment runs on the shared worker (`workerProvider`, `workerModel`, `workerEffort`), so a config from before roles behaves exactly as it did. Assignments live under `roles` in `~/.kumo/config.json`:

```json
"roles": {
  "builder": { "provider": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
  "scout": { "provider": "claude", "model": "claude-haiku-5-5", "effort": "low" },
  "custom": [
    { "id": "docs", "name": "Docs writer", "description": "Use for README and guide edits",
      "prompt": "You keep the documentation accurate…", "access": "write",
      "provider": "claude", "model": "claude-haiku-5-5" }
  ]
}
```

```powershell
kumo role                                   # the lead and every role, with the model each runs on
kumo role set builder sonnet medium         # assign a model (and effort, and provider) to a role
kumo role set scout haiku low claude
kumo role set builder default               # back on the shared worker
kumo role set lead opus high                # the lead is the orchestrator
kumo role add docs --access write --prompt-file docs-role.md --model haiku --description "Use for README and guide edits"
kumo role remove docs
```

- **Effort levels** depend on the model, and Settings › Models offers only the ones it has, under the provider's own names. Codex lists them per model. Claude Code's 4.7 and newer models take Low, Medium, High, Extra (`xhigh`) and Max, the 4.6 models all but Extra, and 4.5 and older none (Claude Code picks). Antigravity's models take the variants `agy models` lists for each: Low, Medium and High for its Gemini and Claude models, Medium only for GPT-OSS (Kumo's own table of those stands in while agy can't be asked). Kumo passes `--effort` to agy for each of them, as the nearest level the model has (ties go down; Extra and Max go to the highest), so a GPT-OSS role set to High runs at Medium. A saved level the model doesn't have moves to the nearest one below it.
- Each tool's description names its role and model ("Builder role, runs on Claude Sonnet 5.5 (Claude Code), medium effort."), so the lead routes by the actual assignment.
- **Validation:** any provider can fill any role, since access belongs to the role; a model must be one its provider offers (a Claude id on Codex is refused); the lead must be a provider that can delegate (every provider except Cursor and Command Code); custom ids are 2–31 characters of lowercase letters, digits and `-` (`worker_<id>`), and cannot reuse built-in names or tool names. A hand-edited entry that does not validate is skipped with a warning; the other roles still apply.
- **Changing roles while a session runs:** `/role builder sonnet` applies from the next worker call, because the bridge asks its session for the settings on every call. Adding or removing a custom role changes the tool list, so the session restarts the orchestrator and resumes the same conversation (after the current turn, if one is running).
- Per-call `provider`, `model` and `effort` arguments still override a role's assignment for that one call. There are no fallbacks between roles: switching providers mid-task breaks prompt caching and continuity.

## Model Configuration & Arrow-Key Navigation

Kumo provides dual-layer model configuration: an interactive arrow-key selector and direct CLI / in-session commands.

### 1. Interactive Model Picker (`/model` or `kumo model`)

Launch the arrow-key menu by running `kumo model` in your terminal or typing `/model` inside an active interactive session:

- **Arrow-Key Navigation**: Navigate options with `↑` / `↓`, jump with `Home` / `End`, page with `PageUp` / `PageDown`, press `Enter` to select, or press `Left Arrow` / `Esc` to go back.
- **Provider-First Model Picker**: Arrow-key dialog (`/model` or `kumo model`) grouping Subscription CLIs (`codex, antigravity, claude, opencode, commandcode, copilot, cursor, ollama`) and Direct API (`openai-api, anthropic-api, gemini-api, compat-api` — env keys, never stored) with atomic flicker-free redraw and back navigation.
- **Dynamic Quota Synchronization**: The startup header and `/status` command automatically adapt their quota progress bars to reflect the provider chosen for each role.

### 2. Built-in Presets

| Preset | Orchestrator | Effort | Worker | Effort | Target Usage |
|---|---|---|---|---|---|
| `default` | `gpt-6-astra` (codex) | `low` | `gemini-3.8-flash` (antigravity) | `medium` | Everyday development (ChatGPT + Google AI Pro) |
| `pro` | `gpt-6-astra` (codex) | `medium` | `gemini-3.8-flash` (antigravity) | `high` | Complex architecture & deep reasoning (ChatGPT Pro) |
| `speed` | `gpt-6-luna` (codex) | `low` | `gemini-3.8-flash` (antigravity) | `low` | High-speed iteration and rapid turnaround |
| `claude` | `claude-opus-5-5` (claude) | `medium` | `claude-haiku-5-5` (claude) | `low` | Everything on your Claude subscription, through Claude Code, with roles: Opus designs and reviews, Sonnet builds and tests, Haiku scouts and researches |
| `claude-sonnet` | `claude-sonnet-5-5` (claude) | `low` | `claude-haiku-5-5` (claude) | `low` | Lighter Claude Code pairing that stretches usage |
| `claude-flash` | `claude-opus-5-5` (claude) | `medium` | `gemini-3.8-flash` (antigravity) | `medium` | Claude Code orchestrator + Antigravity worker |
| `opus-astra` | `claude-opus-5-5` (antigravity) | `high` | `gpt-6-astra` (codex) | `low` | Claude Opus via Google AI Pro + Codex worker |
| `opus-flash` | `claude-opus-5-5` (antigravity) | `high` | `gemini-3.8-flash` (antigravity) | `medium` | Claude Opus and Gemini, both on Google AI Pro |
| `argon` | `gemini-4-argon` (antigravity) | `medium` | `gemini-3.8-flash` (antigravity) | `medium` | All-Google pairing |
| `test` | `gpt-6-luna` (codex) | `low` | `gemini-3.8-flash` (antigravity) | `low` | Lowest quota verification |

Presets also set the built-in roles: the `claude` preset puts Opus 5.5 on the designer and reviewer, Sonnet 5.5 on the builder and tester, and Haiku 5.5 on the scout and researcher; the other presets put every built-in role on their worker. Applying a preset never removes your custom roles.

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

# Give one role its own model (see Assigning Models to Roles)
kumo role set reviewer gpt-6-astra high
```
