# Safety and Configuration

Safety modes, environment variables, timeouts, and the knowledge-integrity rules. Back to the [README](../README.md).

## Safety Modes & Guardrails

Kumo provides three safety modes for worker execution (`kumo config set safetyMode <mode>` or `KUMO_SAFETY_MODE`), governing every write role: `worker_implement`, `worker_test`, `worker_design` and custom write roles:

| Safety Mode | Behavior | Use Case |
|---|---|---|
| `autonomous` (Default) | Automatically applies file changes with no approval gate, then appends verified post-execution `[Applied Files & Diff Summary]` to tool output. | Fast headless execution, prototyping, internal repos. |
| `diff-review` | Two-phase programmatic preview gate: Phase 1 runs the worker read-only to produce a unified diff (`confirm: false`). Phase 2 runs only when the *calling orchestrator model* re-invokes with `confirm: true` and a matching `previewId`; Kumo then applies **exactly the approved diff** with `git apply` (checked first, so a stale patch leaves the tree untouched). Only if the diff no longer applies is the worker asked to redo the task with write permission, and the result says so and lists any divergence from the preview. Note the orchestrator model approves its own previews here — this is a review step, not a human gate. | Multi-turn programmatic validation, headless CI pipelines. |
| `interactive` | Same two phases, but Phase 2 first asks a human on the `kumo` REPL's TTY (`Approve? [y/N/d]`). The bridge asks the session over the engine connection; a bridge that cannot reach it falls back to approval files. If the approved diff no longer applies, nothing is written and a new preview is requested — the worker is never re-run with write access behind the operator's back. Without a REPL listening (e.g. `kumo run`), it behaves like `diff-review`. | Critical client work, production codebases, high-stakes manual oversight. |

The worker's permission is decided per call by the bridge, not by the safety mode: read-only tools and previews launch the worker read-only (e.g. `codex exec --sandbox read-only`), autonomous writes and confirmed re-runs launch it with write access (`--sandbox workspace-write`, `--dangerously-skip-permissions`, `--approval-mode yolo`, … depending on the CLI). Approval requests from the orchestrator itself (e.g. Codex wanting to run a command) are shown in the REPL as `y/N` prompts and declined automatically in `kumo run`.

## Environment Variables

Kumo inspects the following environment variables to configure workspaces, execution parameters, endpoints, and runtime behavior:

| Variable | Read At | Purpose |
|---|---|---|
| `KUMO_WORKSPACE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Target workspace directory for the MCP bridge |
| `ORCHESTRATOR_WORKSPACE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Legacy fallback for `KUMO_WORKSPACE` |
| `KUMO_HOME` | `src/config/paths.js` | Overrides the `~/.kumo` state directory (used for testing and isolated sessions) |
| `KUMO_NO_SYNC` | `src/config/sync.js` | Set to `1` to disable every provider-config write, including `kumo init`'s sync and Antigravity's `.agents/mcp_config.json` |
| `KUMO_SAFETY_MODE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Override safety mode (`autonomous`, `diff-review`, `interactive`) |
| `KUMO_HERE` | `src/commands/start.js` | Run interactive session directly in current terminal (equivalent to `--here`) |
| `KUMO_DEBUG` | `src/providers/orchestrators/agy-client.js`, `src/providers/orchestrators/codex-client.js` | Enable verbose client notification and tool-call logging |
| `KUMO_TRUST_WORKSPACE` | `src/bridge/agy-runner.js` | Set to `false` to stop passing `--skip-trust` to worker subprocesses |
| `KUMO_SKIP_TRUST` | `src/bridge/agy-runner.js` | Alias for `KUMO_TRUST_WORKSPACE` |
| `KUMO_WORKER_PROVIDER` | `src/bridge/server.js` | Per-environment worker provider override (takes precedence over `config.workerProvider`) |
| `KUMO_SYNC_GLOBAL_GEMINI` | `src/config/sync.js` | Set to `1` to opt in to writing global `~/.gemini/config/mcp_config.json` |
| `KUMO_OBSIDIAN_VAULT` | `src/config/settings.js` | Absolute path to the Obsidian Agent-Workspace knowledge vault |
| `GEMINI_MODEL` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Override worker model for execution worker dispatches |
| `GEMINI_EFFORT` / `WORKER_EFFORT` | `src/bridge/agy-runner.js` | Override worker reasoning effort (`low`, `medium`, `high`) |
| `GEMINI_TIMEOUT_MS` | `src/bridge/agy-runner.js` | Execution worker subprocess timeout in milliseconds (default: 300000 / 5m) |
| `AGY_BIN` / `CODEX_BIN` / `CLAUDE_BIN` / `OLLAMA_BIN` / … | provider adapters | Absolute path to a provider CLI, overriding PATH lookup |
| `OPENAI_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `openai-api` provider |
| `ANTHROPIC_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `anthropic-api` provider |
| `GEMINI_BASE_URL` / `GOOGLE_GENERATIVE_AI_BASE_URL` | `src/providers/api/api-transport.js` | Endpoint override for `gemini-api` provider |
| `KUMO_ENGINE_ENDPOINT` / `KUMO_SESSION_TOKEN` | `src/bridge/server.js` | Set by a Kumo session for the orchestrator it starts, so the bridge can reach that session (named pipe or 0700 unix socket, per-session token). Not for manual use. |
| `KUMO_STRICT_EVENTS` | `src/core/events.js` | Set to `1` to validate every engine event against its schema (useful when changing the event contract) |
| `KUMO_ENGINE_ROOT` | `apps/desktop/src/main/` | The engine's `src/` directory for the desktop app (defaults to the repository's) |
| `KUMO_E2E` / `KUMO_E2E_CLIENT` | `apps/desktop/src/main/engine-host.ts` | Testing hook for the desktop app: with both set, the engine uses the scripted client module at that path instead of a provider |

Timeouts are configured separately: `timeoutMs` (default 5 min) bounds each worker call, `turnTimeoutMs` (default 30 min) bounds a whole orchestrator turn. A timed-out or Ctrl+C'd turn is interrupted at the orchestrator, and the prompt returns only once it has actually stopped. The Antigravity provider prefers the `agy` binary; set `cliBinary` (or `AGY_BIN`) to override it, or choose the `gemini-cli` provider to use the Gemini CLI as a worker.

## Knowledge & Documentation Integrity

1. **Graphify (`graphify-out/`)**:
   - Code exploration consults `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`) when present as a structural map of clusters and god nodes. Always verify active symbols against current source code (`kumo graph --check` detects staleness).
2. **Obsidian Knowledge Vault**:
   - Lasting architectural decisions, verified multi-step procedures, and project handoffs are recorded in the shared Obsidian workspace (configured via `$KUMO_OBSIDIAN_VAULT` or `kumo config set obsidianVault <path>`).
3. **Immediate README Maintenance**:
   - **Whenever a major change is made** (features, commands, configuration, or architecture), **`README.md` must be updated immediately** to preserve documentation synchronization.
