# Architecture Deep Dive: Cross-Provider AI Orchestration

This document details the design principles, protocols, and mechanisms powering the Codex × Gemini harness.

---

## The Cross-Provider Problem

Developers often subscribe to multiple flagship AI ecosystems:
- **OpenAI (ChatGPT Plus / Pro)**: Exceptional reasoning, high-level task planning, nuanced architectural synthesis (e.g. ChatGPT 6 Astra).
- **Google (Google AI Pro / Antigravity)**: Fast, high-throughput, expansive context window models (e.g. Gemini 3.8 Flash).

However, each provider's CLI only interfaces directly with its own models. Conventional multi-agent frameworks require separate API keys with per-token billing, bypassing paid consumer subscriptions.

---

## The Solution: Stdio MCP Subprocess Bridge

The **Model Context Protocol (MCP)** provides an open, standardized RPC protocol over standard I/O (`stdio`).

```
┌────────────────────────────────────────────────────────┐
│ Codex CLI (Node / Native Process)                      │
│ - Model: ChatGPT 6 Astra (Reasoning: low)              │
│ - Config: .codex/config.toml                           │
└───────────────────────────┬────────────────────────────┘
                            │ stdio JSON-RPC
                            ▼
┌────────────────────────────────────────────────────────┐
│ MCP Bridge Server (bridge/server.js)                   │
│ - Uses @modelcontextprotocol/sdk                       │
│ - Exposes gemini_* MCP tools                           │
└───────────────────────────┬────────────────────────────┘
                            │ Subprocess spawn
                            ▼
┌────────────────────────────────────────────────────────┐
│ Antigravity / Gemini CLI (agy / gemini)                │
│ - Model: Gemini 3.8 Flash                              │
│ - Sandbox: read-only | workspace-write                 │
│ - Authenticated via Google AI Pro subscription         │
└────────────────────────────────────────────────────────┘
```

### 1. Subscription-Level Authentication
- No API keys are stored in files or transmitted in network headers.
- Codex CLI relies on `codex login`.
- Antigravity CLI relies on `agy auth login` (or Google account credentials).
- The subprocess inherits the user's OS user session and profile environment.

### 2. Sandbox Mode Enforcement
- **Read-Only Tools (`gemini_explore`, `gemini_research`, `gemini_review`)**:
  - Spawned with `--sandbox read-only` (or `--approval-mode plan`).
  - Ensures the worker cannot accidentally delete or alter files when merely searching or checking facts.
- **Write-Enabled Tools (`gemini_implement`, `gemini_test`)**:
  - Spawned with `--sandbox workspace-write` (or `--approval-mode yolo`).
  - Allows targeted code generation and test execution within the workspace boundaries.

### 3. Rate Limit Optimization for ChatGPT Plus
- ChatGPT Plus enforces a message cap per 3-hour window.
- In traditional single-provider workflows, every file read, symbol search, and small code iteration consumes valuable orchestrator turns.
- In this harness:
  - Astra issues a single prompt to `gemini_explore` or `gemini_implement`.
  - Gemini performs the multi-file searches or edits locally in a single subprocess run.
  - Gemini returns a structured summary to Astra, preserving the orchestrator's quota.

### 4. Cross-Model Validation
A single model reviewing its own generated code has natural confirmation bias. When **Astra** reviews **Gemini's** code:
- Astra analyzes the AST, edge cases, and types with a completely independent model architecture.
- Discrepancies between Gemini's output and project specifications are caught prior to user review.
