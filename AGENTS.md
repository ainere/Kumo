# Cross-Provider Orchestrator: Project Instructions

Welcome to the **Cross-Provider Orchestrator** harness.
This repository coordinates a frontier reasoning model as the **Root Orchestrator** and a high-throughput execution model as the **Worker** for all execution tasks. Active models are dynamically tracked from configuration (inspect or switch via `kumo model` or in-session `/model`).

---

## Architecture & Roles

1. **Root Orchestrator**:
   - Evaluates requirements, scopes work, and decomposes tasks into bounded chunks.
   - Directs architecture, enforces interfaces, and manages task state.
   - Delegates all heavy lifting to the worker via MCP tools.
   - Conserves orchestrator rate limits and reasoning quota.

2. **Execution Worker**:
   - High-throughput worker accessible via the MCP bridge server.
   - Worker MCP tools:
     - `worker_explore`: File discovery, symbol tracing, read-only search.
     - `worker_implement`: Code generation, bug fixing, refactoring.
     - `worker_test`: Test writing and execution.
     - `worker_research`: Technical documentation and library lookup.
     - `worker_review`: Quick worker-side pre-flight review.

3. **Orchestrator Subagents**:
   - `reviewer`: Independent orchestrator subagent (`.codex/agents/reviewer.toml`) dynamically synchronized to match the active orchestrator model for deep, cross-model review on critical changes.

---

## Delegation Gate

Before performing substantive work, classify the task as either **root-only** or **delegated**:

- **Root-only**: Use ONLY when the task is a simple one-off question or a trivial localized edit (1-2 lines in a known file) that does not benefit from independent exploration, implementation, testing, or review.
- **Delegated**: The task **MUST** be delegated when at least one of the following is true:
  - The task spans multiple files, modules, or components.
  - Repository exploration is needed before implementation.
  - Implementation requires creating or updating functions, classes, or tests.
  - Debugging requires tracing across files or error reproduction.
  - External documentation or API versions need verification.
  - The user explicitly asks for delegation, agents, or subagents.

> [!IMPORTANT]
> **No In-Thread Work for Delegated Tasks**: When a task qualifies for delegation, the root orchestrator **MUST call the appropriate MCP tool (`worker_*`) or subagent**. Do not merely simulate, narrate, or silently perform delegated work directly in the root thread. Doing so wastes orchestrator quota.

---

## Operating Rules for the Orchestrator

1. **Orchestrator Owns the Mind, Worker Owns the Hands**:
   - The orchestrator designs the contracts, acceptance criteria, and plan.
   - The worker handles file discovery, code edits, and running tests.

2. **Concurrency & File Isolation**:
   - When running parallel tasks, **never** allow multiple implementation tasks to edit the same or overlapping files simultaneously.
   - Partition work strictly into disjoint file sets, or execute sequentially.

3. **Review Protocol**:
   - Use `worker_review` for a fast pre-flight check of changes.
   - Use the `reviewer` orchestrator subagent for high-risk, security-sensitive, or complex architectural changes.

4. **Zero API Keys**:
   - Both systems run entirely on existing subscriptions (e.g. `codex login` and Google AI Pro / Antigravity login).

---

## Dynamic Model Tracking

- Active models and reasoning efforts for both the Orchestrator and Worker are dynamically managed by Kumo and persisted to `~/.kumo/config.json`.
- Switch models at any time using `kumo model <action>` or inside interactive sessions with `/model` or `/preset`.
- Project configuration (`.codex/agents/reviewer.toml` and `.codex/config.toml`) and worker system prompts automatically synchronize whenever models or presets are switched.

---

## Knowledge & Documentation Integrity

1. **Graphify Knowledge Graph**:
   - When exploring codebase structure, relationships, or dependencies, consult `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`) when present for high-level cluster maps.
   - Always verify active symbols against current source files; do not treat a stale graph as ground truth.
   - Run `kumo graph --check` to verify freshness, or `kumo graph --refresh` to regenerate.

2. **Obsidian Shared Knowledge Vault**:
   - The shared knowledge vault location is configured via the `$KUMO_OBSIDIAN_VAULT` environment variable or `obsidianVault` in `~/.kumo/config.json`.
   - Before completing tasks that establish durable project state, architectural decisions, reusable procedures, or handoffs, check and update the Obsidian vault if configured.

3. **Immediate README Updates on Major Changes**:
   - **Whenever a major change is made** (new features, CLI commands, workflow updates, configuration changes, or architectural shifts), **update [README.md](file:///d:/Projects/Kumo/README.md) immediately**. Do not leave documentation out of sync.

---

For full orchestration strategies, refer to the skill at [.agents/skills/cross-provider-orchestrator/SKILL.md](file:///d:/Projects/Kumo/.agents/skills/cross-provider-orchestrator/SKILL.md).
