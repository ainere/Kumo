# Architecture Deep Dive: Cross-Provider AI Orchestration

This document details the design principles, protocols, and mechanisms powering the Kumo cross-provider harness.

---

## The Cross-Provider Problem

- **Frontier reasoning CLIs** (e.g. Codex / ChatGPT, Claude Code, Copilot, Cursor, Gemini CLI, Ollama): deep planning, nuanced architectural synthesis.
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
- Optional direct-API providers (`openai-api`, `anthropic-api`, `gemini-api`, `compat-api`) take keys from env vars only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `COMPAT_API_KEY` optional + `COMPAT_BASE_URL`). Kumo never persists your keys. Only the API keys relevant to the selected provider are forwarded to the provider CLIs Kumo launches; other secret-looking environment variables are stripped from the child environment.
- The subprocess inherits the user's OS user session and profile environment.

### 2. Execution Permissions & Safety Modes
- **Read-Only Tools (`worker_explore`, `worker_research`, `worker_review`, custom read roles)**:
  - Where the CLI can enforce it, the worker is launched read-only: `codex exec --sandbox read-only`; Claude Code with `--permission-mode dontAsk` and `Edit,Write,NotebookEdit` denied; headless `agy` without permission flags (it then refuses tools that need a prompt).
  - For other CLIs read-only behavior rests on the prompt wording and is **advisory**, not an OS sandbox.
- **Write-Enabled Tools (`worker_implement`, `worker_test`, `worker_design`, custom write roles)**:
  - The bridge decides each worker call's permission: read-only tools and diff previews run read-only; autonomous writes and confirmed re-runs get write access. With write access, Kumo passes `-y --approval-mode yolo` to the Gemini CLI, `--dangerously-skip-permissions --mode accept-edits` to `agy`, and `--sandbox workspace-write` to `codex exec` (`--sandbox read-only` otherwise).
  - When `trustWorkspace` is enabled (default `true`), `--skip-trust` is passed and `GEMINI_CLI_TRUST_WORKSPACE=true` is set in the child environment.
  - Under `safetyMode: "diff-review"`, write tools run in diff-preview mode and require the calling orchestrator model to explicitly confirm with `confirm: true` and a matching `previewId`. Under `safetyMode: "interactive"`, a human approval prompt on the REPL TTY gates application. Either way, the approved diff itself is applied with `git apply`; the worker re-runs only if that diff no longer applies, and the result says so.
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
