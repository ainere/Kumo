# Safety and Configuration

Safety modes, environment variables, timeouts, and the knowledge-integrity rules. Back to the [README](../README.md).

## Safety Modes & Guardrails

Kumo provides three safety modes for worker execution (`kumo config set safetyMode <mode>` or `KUMO_SAFETY_MODE`), governing every write role: `worker_implement`, `worker_test`, `worker_design` and custom write roles:

| Safety Mode | Behavior | Use Case |
|---|---|---|
| `autonomous` (Default) | Automatically applies file changes with no approval gate, then appends verified post-execution `[Applied Files & Diff Summary]` to tool output. | Fast headless execution, prototyping, internal repos. |
| `diff-review` | Two-phase programmatic preview gate: Phase 1 runs the worker read-only to produce a unified diff (`confirm: false`). Phase 2 runs only when the *calling orchestrator model* re-invokes with `confirm: true` and a matching `previewId`; Kumo then applies **exactly the approved diff** with `git apply` (checked first, so a stale patch leaves the tree untouched). If the diff no longer applies, nothing is written and a new preview is requested, whichever worker proposed it. No worker runs with write access in this mode, because what it wrote would be a change nobody saw. A Phase 1 reply with no diff in it is answered with `[STATUS: NO_DIFF]` and gets no `previewId`, so there is nothing to confirm. A diff that touches `.git/`, `.codex/`, `.claude/`, `.agents/` or `.gemini/`, creates or changes a symbolic link, names a path outside the workspace, or runs through a link or Windows junction already in the workspace is refused whole: nothing is written. A patch that only renames a file or changes its mode goes through the same checks. Note the orchestrator model approves its own previews here — this is a review step, not a human gate. | Multi-turn programmatic validation, headless CI pipelines. |
| `interactive` | Same two phases, but Phase 2 first asks a human on the `kumo` REPL's TTY (`Approve? [y/N/d]`). The bridge asks the session over the engine connection; a bridge that cannot reach it falls back to approval files. As in `diff-review`, an approved diff that no longer applies writes nothing, and a new preview is requested for the operator to approve. Without a REPL listening (e.g. `kumo run`), it behaves like `diff-review`. | Critical client work, production codebases, high-stakes manual oversight. |

The worker's permission is decided per call by the bridge, not by the safety mode: read-only tools and previews launch the worker read-only (e.g. `codex exec --sandbox read-only`, `--mode ask` on Cursor, `--plan` on Command Code, or edit denials via `OPENCODE_CONFIG_CONTENT` on OpenCode), while only autonomous writes launch it with write access (`--sandbox workspace-write`, `--dangerously-skip-permissions`, `--approval-mode yolo`, `--auto`, … depending on the CLI). Approval requests from the orchestrator itself (e.g. Codex wanting to run a command) are shown in the REPL as `y/N` prompts and declined automatically in `kumo run`.

Kumo always holds a gated mode to the approved diff. Earlier builds read a `KUMO_EXACT_DIFF_ONLY` variable to switch that rule on; it is gone, and setting it does nothing.

## Files Kumo Leaves Alone

Saving a setting or applying a preset changes only the keys it names in `~/.kumo/config.json`. Keys this version of Kumo doesn't know, and custom roles it can't validate, stay in the file as they were, so a config written by a newer Kumo or edited by hand survives a model switch.

Kumo merges its bridge entry into provider config files such as `.agents/mcp_config.json` (and `~/.gemini/config/mcp_config.json` when `KUMO_SYNC_GLOBAL_GEMINI=1`). If one of those files has content that isn't a JSON object (a comment, a trailing comma, an array), Kumo doesn't overwrite it. `kumo init` lists the file under what it skipped, with the reason. Fix or remove the file, then run it again.

A rewind leaves some files alone as well: ignored files, files over the snapshot size limit, links, and files under a git filter the repository defines for itself (git-crypt, for one). It neither writes nor deletes them, and the preview lists the paths it couldn't change. A project with more than 1 GB of new files that git doesn't ignore gets no checkpoint at all for that turn, since a partial one could make a rewind delete files it never saved. The session warns once, and checkpoints return when those files are ignored or committed.

## Profile & Standing Instructions

Two saved defaults in `~/.kumo/config.json` (and **Settings › General** in the desktop app) tell Kumo about you across every project and chat:

| Key | Limit | Who receives it |
|---|---|---|
| `userName` | 80 characters, single line | **Lead only** — tells the orchestrator how to address you (`Address the user as "…".`), never forwarded to worker subprocesses |
| `customInstructions` | 4,000 characters | **Lead and every worker role** — appended to the lead's instructions and included as `[User Instructions]` in every built-in and custom worker system prompt |

```powershell
kumo config set userName "Alex"
kumo config set customInstructions "Prefer concise answers and run narrow tests first."
```

Changes apply on the very next turn without restarting the conversation:
- **Claude Code lead:** written to an owner-only per-conversation file under `~/.kumo/run/` and passed via `--append-system-prompt-file` (never on `argv`).
- **Direct API & Ollama leads:** appended to the system prompt on every request in the tool loop.
- **Other CLI leads (`codex`, `antigravity`, `copilot`, `opencode`, …):** prepended as a `<kumo-profile>…</kumo-profile>` block on the first turn of a chat and whenever the saved profile changes (with any `</kumo-profile>` in user text escaped so it cannot close the block early).
- **Diagnostics (`kumo doctor`):** redacts `userName` and `customInstructions` to `(set, N characters)` so personal details are not pasted into bug reports.

## Environment Variables

Kumo inspects the following environment variables to configure workspaces, execution parameters, endpoints, and runtime behavior:

| Variable | Read At | Purpose |
|---|---|---|
| `KUMO_WORKSPACE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Target workspace directory for the MCP bridge |
| `ORCHESTRATOR_WORKSPACE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Legacy fallback for `KUMO_WORKSPACE` |
| `KUMO_HOME` | `src/config/paths.js` | Overrides the `~/.kumo` state directory (used for testing and isolated sessions). On Windows, point it at a user-private directory: file modes do not apply there, so the directory's own permissions are all that protect the engine connection's session token (in the Copilot MCP config under `run/`) and your session state |
| `KUMO_NO_SYNC` | `src/config/sync.js` | Set to `1` to disable every provider-config write, including `kumo init`'s sync and Antigravity's `.agents/mcp_config.json` |
| `KUMO_NO_UPDATES` | `apps/desktop/src/main/updates.ts` | Set to `1` to stop the installed desktop app from checking GitHub Releases for updates |
| `KUMO_SAFETY_MODE` | `src/bridge/server.js`, `src/bridge/agy-runner.js` | Override safety mode (`autonomous`, `diff-review`, `interactive`) |
| `KUMO_HERE` | `src/commands/start.js` | Run interactive session directly in current terminal (equivalent to `--here`) |
| `KUMO_DEBUG` | `src/providers/orchestrators/agy-client.js`, `src/providers/orchestrators/codex-client.js` | Enable verbose client notification and tool-call logging |
| `KUMO_WORKER_PROVIDER` | `src/bridge/server.js` | Per-environment worker provider override (takes precedence over `config.workerProvider`) |
| `KUMO_SYNC_GLOBAL_GEMINI` | `src/config/sync.js` | Set to `1` to opt in to writing global `~/.gemini/config/mcp_config.json` |
| `KUMO_OBSIDIAN_VAULT` | `src/config/settings.js` | Absolute path to your Obsidian knowledge vault |
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

Timeouts are configured separately: `timeoutMs` (default 5 min) bounds each worker call, `turnTimeoutMs` (default 30 min) bounds a whole orchestrator turn. A timed-out or Ctrl+C'd turn is interrupted at the orchestrator, and the prompt returns only once it has actually stopped. A running session refreshes the usage of every signed-in CLI every `quotaPollMs` (default 10 s, at least 10 s). Each refresh runs Antigravity's `/usage`, Claude Code's `/usage` (a local command: no model call, no saved session) and a short Codex app-server; to poll less often, run `kumo config set quotaPollMs 30000`. The Antigravity provider runs the `agy` binary; set `cliBinary` (or `AGY_BIN`) to override it.

## Knowledge & Documentation Integrity

1. **Graphify (`graphify-out/`)**:
   - Code exploration consults `graphify-out/` (`GRAPH_REPORT.md`, `graph.json`) when present as a structural map of clusters and god nodes. Always verify active symbols against current source code (`kumo graph --check` detects staleness).
2. **Obsidian Knowledge Vault**:
   - Lasting architectural decisions, verified multi-step procedures, and project handoffs are recorded in the shared Obsidian workspace (configured via `$KUMO_OBSIDIAN_VAULT` or `kumo config set obsidianVault <path>`).
3. **Immediate README Maintenance**:
   - **Whenever a major change is made** (features, commands, configuration, or architecture), **`README.md` must be updated immediately** to preserve documentation synchronization.
