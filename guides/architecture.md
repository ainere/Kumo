# Architecture Deep Dive: Cross-Provider AI Orchestration

This document details the design principles, protocols, and mechanisms powering the Kumo cross-provider harness.

---

## The Cross-Provider Problem

- **Frontier reasoning CLIs** (e.g. Codex / ChatGPT, Claude Code, Copilot, Cursor, Gemini CLI, Ollama): deep planning, nuanced architectural synthesis.
- **High-throughput workers** (e.g. Antigravity / Gemini, Codex, API-backed models): fast, expansive context window execution (e.g. Gemini 3.8 Flash).

However, each provider's CLI only interfaces directly with its own models. Conventional multi-agent frameworks default to separate API keys with per-token billing, bypassing paid consumer subscriptions (Kumo keeps subscriptions the default and supports API keys as an opt-in per-role or per-call path).

---

## The Solution: Stdio MCP Subprocess Bridge

The **Model Context Protocol (MCP)** provides an open, standardized RPC protocol over standard I/O (`stdio`).

```
┌────────────────────────────────────────────────────────┐
│ Root Orchestrator (any of 13 providers)                │
│ - Model: Dynamic (e.g. ChatGPT 6 Astra, GPT-5.5)       │
│ - Config: .codex/config.toml (Auto-synced by Kumo)     │
└───────────────────────────┬────────────────────────────┘
                            │ stdio JSON-RPC
                            ▼
┌────────────────────────────────────────────────────────┐
│ MCP Bridge Server (src/bridge/server.js)               │
│ - Uses @modelcontextprotocol/sdk                       │
│ - Exposes 5 specialized worker_* MCP tools             │
│ - Optional per-call `provider` override                │
└───────────────────────────┬────────────────────────────┘
                            │ Subprocess spawn or direct-API fetch
                            ▼
┌────────────────────────────────────────────────────────┐
│ Execution Worker (any of 13 providers)                 │
│ - Model: Dynamic (e.g. Gemini 3.8 Flash, Claude Opus)  │
│ - Sandbox: read-only | workspace-write (CLI workers)   │
│ - Subscription CLI login, or direct-API env key        │
└────────────────────────────────────────────────────────┘
```
### 1. Subscription-First Authentication (Direct API Optional)
- Subscription CLIs need no API keys in files or network headers: orchestrator relies on `codex login`, worker on `agy auth login` (or Google account credentials).
- Optional direct-API providers (`openai-api`, `anthropic-api`, `gemini-api`, `compat-api`) take keys from env vars only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `COMPAT_API_KEY` optional + `COMPAT_BASE_URL`); keys are never written to disk, cache, logs, or `~/.kumo/*`.
- The subprocess inherits the user's OS user session and profile environment.

### 2. Sandbox Mode Enforcement
- **Read-Only Tools (`worker_explore`, `worker_research`, `worker_review`)**:
  - Spawned with `--sandbox read-only` (or `--approval-mode plan`).
  - Ensures the worker cannot accidentally delete or alter files when merely searching or checking facts.
- **Write-Enabled Tools (`worker_implement`, `worker_test`)**:
  - Spawned with `--sandbox workspace-write` (or `--approval-mode yolo`).
  - Allows targeted code generation and test execution within the workspace boundaries.

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
- The `reviewer` subagent (`.codex/agents/reviewer.toml`) dynamically mirrors the active orchestrator model and explicitly names both models for genuine cross-model independence.
- Discrepancies between worker output and project specifications are caught prior to user presentation.

### 5. Knowledge Graph & Durable Memory
- **Graphify**: Code structure, god nodes, and cross-module call paths are tracked in `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`). Workers verify active symbols against current source code to prevent stale misdirection.
- **Obsidian Shared Knowledge Vault**: Durable cross-session state, architectural decisions, and reusable procedures are maintained in the configured Obsidian vault (configured via `$KUMO_OBSIDIAN_VAULT` or `kumo config set obsidianVault <path>`).
