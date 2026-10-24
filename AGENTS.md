# Cross-Provider Orchestrator: Project Instructions

Welcome to the **Cross-Provider Orchestrator** harness.
This repository coordinates a frontier reasoning model as the **Root Orchestrator** (the lead) and a set of **worker roles** for all execution tasks. Each role can run on its own model, picked from any logged-in subscription; roles without one share the **Worker** model. Active models are dynamically tracked from configuration (inspect or switch via `kumo role`, `kumo model`, or in-session `/role` and `/model`).

---

## Architecture & Roles

1. **Root Orchestrator**:
   - Evaluates requirements, scopes work, and decomposes tasks into bounded chunks.
   - Directs architecture, enforces interfaces, and manages task state.
   - Delegates all heavy lifting to the worker via MCP tools.
   - Conserves orchestrator rate limits and reasoning quota.

2. **Worker Roles**:
   - Each role is one MCP tool on the bridge server and runs on the model assigned to it (`roles` in the config); a role without an assignment runs on the shared worker (`workerProvider` / `workerModel` / `workerEffort`).
   - Worker MCP tools, by role:
     - scout, `worker_explore`: File discovery, symbol tracing, read-only search.
     - builder, `worker_implement`: Code generation, bug fixing, refactoring.
     - tester, `worker_test`: Test writing and execution.
     - researcher, `worker_research`: Technical documentation and library lookup.
     - reviewer, `worker_review`: Independent pre-flight review.
     - designer, `worker_design`: Visual and interaction design and the design-facing code that realizes it.
     - custom roles, `worker_<id>`: Defined by the user (`kumo role add`), read or write, with their own instructions.
   - Each tool's description names its role and model. **Route by the actual assignment**: send judgment-heavy work to the roles on stronger models and bulk or mechanical work to the faster ones, and do not override a role's model per call unless the user asked.

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

2. **Concurrency & File Ownership**:
   - When running parallel tasks, **never** allow two write calls (`worker_implement`, `worker_test`, `worker_design`, custom write roles) to edit the same or overlapping files simultaneously.
   - Give each parallel write call a disjoint set of files and name it in the brief; shared files (indexes, routers, `package.json`) belong to one call or a later sequential step. Otherwise execute sequentially.

3. **Five-Part Briefs**:
   - Every worker call states its **objective** (the one outcome), **scope** (the files it owns and what it must not touch), **constraints** (interfaces and conventions to keep, what is out of bounds), **deliverable** (what to return), and **acceptance** (how to tell it is done).

4. **Review Protocol**:
   - Use `worker_review` for a fast pre-flight check of changes.
   - Use the `reviewer` orchestrator subagent for high-risk, security-sensitive, or complex architectural changes.

5. **Subscriptions Default, Direct API Optional**:
   - Both systems run on existing subscriptions by default (e.g. `codex login` and Google AI Pro / Antigravity login).
   - Direct-API providers (`openai-api`, `anthropic-api`, `gemini-api`, `compat-api`) use env-var keys only (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `COMPAT_API_KEY` optional, `COMPAT_BASE_URL`). Kumo never persists your keys. Only the API keys relevant to the selected provider are forwarded to the provider CLIs Kumo launches; other secret-looking environment variables are stripped from the child environment.

6. **Bounded Scope & Granular Delegation**:
   - **Never** delegate an open-ended mega-task (e.g. "audit everything and fix all problems") to a single worker tool call.
   - Decompose complex workflows into bounded, sequential steps (explore specific files -> analyze -> implement focused diff -> run targeted test). Single worker calls should complete in under 60 seconds to avoid gateway and socket timeouts.

---

## Dynamic Model Tracking

- Active models and reasoning efforts for the Orchestrator, each role and the shared Worker are dynamically managed by Kumo. `~/.kumo/config.json` holds the defaults; each running session (a REPL window, `kumo run`) keeps its own copy, and the bridge asks its session for them on every worker call.
- Switch models at any time using `kumo role set <role> <model>`, `kumo model <action>`, or inside interactive sessions with `/role`, `/model` or `/preset`. Presets fill the roles too (the `claude` preset: Opus lead, designer and reviewer; Sonnet builder and tester; Haiku scout and researcher).
- Worker system prompts always name the active models. Project configuration (`.codex/agents/reviewer.toml` and `.codex/config.toml`) is opt-in: `kumo init` creates it, and sessions keep it in step with model and preset switches only in workspaces initialized that way.

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
   - **Whenever a major change is made** (new features, CLI commands, workflow updates, configuration changes, or architectural shifts), **update [README.md](README.md) immediately**. Do not leave documentation out of sync.

---

For full orchestration strategies, refer to the skill at [.agents/skills/cross-provider-orchestrator/SKILL.md](.agents/skills/cross-provider-orchestrator/SKILL.md).
