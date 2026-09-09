# Codex × Gemini Cross-Provider Orchestrator: Project Instructions

Welcome to the **Codex × Gemini Orchestrator** harness.
This repository links **ChatGPT 6 Astra** (via Codex CLI on ChatGPT Plus) as the root orchestrator and **Gemini 3.8 Flash** (via Antigravity CLI on Google AI Pro) as the worker for all implementation and execution tasks.

---

## Architecture & Roles

1. **Root Orchestrator (Astra Low)**:
   - Evaluates requirements, scopes work, and breaks tasks into bounded chunks.
   - Delegates exploration, implementation, testing, and research to Gemini via MCP tools.
   - Conducts independent code reviews of Gemini's work.
   - Conserves ChatGPT Plus quota by avoiding reading massive files directly.

2. **Grunt Worker (Gemini 3.8 Flash)**:
   - Accessed via the `gemini-bridge` MCP server.
   - MCP tools:
     - `gemini_explore`: File discovery, symbol tracing, read-only search.
     - `gemini_implement`: Code generation, bug fixing, refactoring.
     - `gemini_test`: Test writing and execution.
     - `gemini_research`: Technical documentation and library lookup.
     - `gemini_review`: Secondary review.

3. **Subagents**:
   - `reviewer`: ChatGPT 6 Astra subagent for deep cross-model review when extensive verification is required.

---

## Operating Rules for Astra

- **Never read entire large repositories directly**: When you need to understand where code is or how it works, call `gemini_explore`.
- **Never hand-write huge blocks of boilerplate**: When implementation is needed, specify the contract and call `gemini_implement`.
- **Always verify test coverage**: Call `gemini_test` to write and execute tests.
- **Review before completion**: Check diffs with critical rigor (security, edge cases, regression).
- **Zero API keys**: Both systems run on your logged-in subscriptions (`codex login` and Google AI Pro / Antigravity login).

For full orchestration strategies, refer to the skill at `.agents/skills/cross-provider-orchestrator/SKILL.md`.
