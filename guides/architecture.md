# Architecture Deep Dive: Cross-Provider AI Orchestration

This document details the design principles, protocols, and mechanisms powering the Kumo cross-provider harness.

---

## The Cross-Provider Problem

- **Frontier reasoning CLIs** (e.g. Codex / ChatGPT, Claude Code, Copilot, Cursor, Ollama): deep planning, nuanced architectural synthesis.
- **High-throughput workers** (e.g. Antigravity / Gemini, Codex, API-backed models): fast, expansive context window execution (e.g. Gemini 3.8 Flash).

However, each provider's CLI only interfaces directly with its own models. Conventional multi-agent frameworks default to separate API keys with per-token billing, bypassing paid consumer subscriptions (Kumo keeps subscriptions the default and supports API keys as an opt-in per-role or per-call path).

---

## The Solution: Stdio MCP Subprocess Bridge

The **Model Context Protocol (MCP)** provides an open, standardized RPC protocol over standard I/O (`stdio`). Each chat runs an Engine `Session` (`src/core/session.js`) for the CLI or desktop app; the session starts the root orchestrator (`codex`, `claude`, or `antigravity`), which connects over `stdio` MCP to Kumo's bridge server (`src/bridge/server.js`) exposing one `worker_*` tool per role and spawning or calling the configured worker models.

The bridge reaches the session that started its orchestrator through the
endpoint and token in its environment (Codex forwards them by name with
`env_vars`, Claude Code through the per-session MCP config, Antigravity by
inheritance). It takes the role assignments, shared worker, model, effort and safety mode
from that session on every call (and builds its tool list from the session's
roles when it starts), streams each worker run's output tagged with its run
(the session matches runs to the orchestrator's tool calls by tool and task),
and asks the session for approvals. A bridge with no engine — started by a
plain `codex` with a `kumo init` config — falls back to the saved config,
live-log files and approval files.

### 1. Subscription-First Authentication (Direct API Optional)
- Subscription CLIs need no API keys in files or network headers: each runs on its own login (`codex login`, Claude Code's login, `agy`'s Google account). Claude Code is never handed `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, so it stays on the subscription.
- Optional direct-API providers (`openai-api`, `anthropic-api`, `gemini-api`, `compat-api`) take keys from env vars only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `COMPAT_API_KEY` optional + `COMPAT_BASE_URL`). Kumo never persists your keys. Every provider CLI Kumo launches, lead or worker, gets a scrubbed environment: secret-looking variables (API keys, tokens, secrets, passwords, `*_KEY`, database and broker URLs, webhook URLs, DSNs) are stripped, and only that provider's own login passes through (`CLAUDE_CODE_OAUTH_TOKEN` for Claude Code, `GH_TOKEN` / `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` for Copilot, `CURSOR_API_KEY` for Cursor, `OLLAMA_API_KEY` for Ollama). A Codex or Claude Code lead also passes on the names its bridge needs (direct-API keys, base URLs, CLI path overrides, and the login of any Copilot or Cursor worker the session assigns), through the CLI's environment and never in a config file. `ELECTRON_RUN_AS_NODE`, which the desktop app sets for the bridge, is never inherited by a child.
- The subprocess inherits the user's OS user session and profile environment.
- Kumo starts every program by absolute path. Provider CLIs are looked up in the folders on PATH only, never in the project folder (Windows would otherwise look there first, so a project could ship its own `git.exe` or `claude.cmd`), and `cmd.exe`, `taskkill` and Windows PowerShell come from System32. Git runs the same way in the engine and the bridge: the repository's own hooks, `core.fsmonitor`, filter drivers, external diff and textconv are switched off.

### 2. Execution Permissions & Safety Modes
- **Read-Only Tools (`worker_explore`, `worker_research`, `worker_review`, custom read roles)**:
  - Where the CLI can enforce it, the worker is launched read-only: `codex exec --sandbox read-only`; Claude Code with `--permission-mode dontAsk` and `Edit,Write,NotebookEdit` denied; headless `agy` without permission flags (it then refuses tools that need a prompt).
  - For other CLIs read-only behavior rests on the prompt wording and is **advisory**, not an OS sandbox.
- **Write-Enabled Tools (`worker_implement`, `worker_test`, `worker_design`, custom write roles)**:
  - The bridge decides each worker call's permission: read-only tools and diff previews run read-only, and only an autonomous write gets write access. With write access, Kumo passes `--dangerously-skip-permissions --mode accept-edits` to `agy`, and `--sandbox workspace-write` to `codex exec` (`--sandbox read-only` otherwise).
  - Under `safetyMode: "diff-review"`, write tools run in diff-preview mode and require the calling orchestrator model to explicitly confirm with `confirm: true` and a matching `previewId`. Under `safetyMode: "interactive"`, a human approval prompt on the REPL TTY gates application. Either way, a confirmation writes the approved diff with `git apply` and nothing else, so no worker runs with write access in a gated mode. If the diff no longer applies, nothing is written and a new preview is requested. A preview with no diff in it is answered with `[STATUS: NO_DIFF]` and gets no `previewId`, so it can't be confirmed. One `previewId` can be confirmed by one call at a time. A diff that touches `.git/`, `.codex/`, `.claude/`, `.agents/` or `.gemini/`, creates or changes a symbolic link, names a path outside the workspace, or runs through a link or Windows junction already in the workspace is refused whole: nothing is written. A patch that only renames a file or changes its mode goes through the same checks. So does one that names a protected folder by the short name Windows gave it (`CLAUDE~1`, or a hashed one such as `CL59A6~1`): each part of a path that exists is judged by its real name on disk. The check does not trust the patch's own wording: it asks `git apply` which files and modes it reads in the patch (`--numstat`, `--summary`) and refuses on those, and git's own `invalid path` and `beyond a symbolic link` errors count as refusals too.
### 3. Rate Limit Optimization for Frontier Models
- Frontier orchestrators enforce message caps per rolling window.
- In traditional single-provider workflows, every file read, symbol search, and small code iteration consumes valuable orchestrator turns.
- In this harness:
  - The Orchestrator issues a single prompt to `worker_explore` or `worker_implement`.
  - The Worker performs multi-file searches or edits locally in a single subprocess run.
  - The Worker returns a structured summary to the Orchestrator, preserving reasoning turns.

### 4. Cross-Model Validation & Dynamic Subagents
A single model reviewing its own generated code has natural confirmation bias. When the **Orchestrator** reviews the **Worker's** code:
- The Orchestrator analyzes the AST, edge cases, and types with a completely independent model architecture.
- The `reviewer` subagent (`.codex/agents/reviewer.toml`, created by `kumo init`) mirrors the active orchestrator model and explicitly names both models for genuine cross-model independence.
- Discrepancies between worker output and project specifications are caught prior to user presentation.

### 5. Knowledge Graph & Durable Memory
- **Graphify**: Code structure, god nodes, and cross-module call paths are tracked in `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`). Workers verify active symbols against current source code to prevent stale misdirection.
- **Obsidian Shared Knowledge Vault**: Durable cross-session state, architectural decisions, and reusable procedures are maintained in the configured Obsidian vault (configured via `$KUMO_OBSIDIAN_VAULT` or `kumo config set obsidianVault <path>`).
