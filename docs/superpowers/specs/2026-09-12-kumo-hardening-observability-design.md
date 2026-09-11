# Kumo Hardening and Observability Design

Date: 2026-09-12

## Scope

This design hardens Kumo's execution/safety semantics, formalizes provider capabilities and configuration handling, and introduces a unified task lifecycle used by both `/status` and live execution timelines. It also addresses the reported failure mode where a chat can stop or become stuck without returning control to the REPL.

The goal is targeted hardening, not a rewrite. Existing provider adapters, MCP bridge, session persistence, and interactive REPL remain the foundation.

## Goals

1. Make diff-review approval apply the exact reviewed change rather than asking a worker to reinterpret the original task.
2. Preserve existing user/provider configuration when Kumo synchronizes its MCP configuration.
3. Make provider behavior explicit through capability contracts instead of scattered model-name and CLI heuristics.
4. Make configuration values typed and validated.
5. Make Git workspace state tracking accurate for dirty, staged, renamed, deleted, space-containing, Unicode, and concurrent changes.
6. Ensure provider process death, stream termination, RPC failures, and server errors always terminate a turn deterministically and return control to the REPL.
7. Add idle/heartbeat protection for streams so a silent upstream does not leave Kumo waiting indefinitely.
8. Introduce a structured task/event lifecycle that powers a live execution timeline and a richer `/status` command.
9. Preserve session/audit information so completed and failed runs can be inspected afterward.
10. Add regression coverage for the failure and safety cases above.

## Non-goals

- Parallel orchestration policies are deferred until the execution/event foundation exists.
- A full terminal UI framework is not introduced.
- Provider-specific feature parity is not forced when a provider genuinely lacks a capability.
- Existing subscriptions/API-key model remains unchanged.

## Architecture

### Task lifecycle

Introduce a provider-agnostic `TaskRun`/event layer between the REPL and provider clients.

A run has:

- stable `runId`
- chat/session identifier
- workspace
- provider and model metadata
- start/end timestamps
- current phase/status
- child execution items
- terminal outcome
- error information when applicable

Events use a small, typed vocabulary:

- `run_started`
- `phase_started`
- `worker_started`
- `worker_output`
- `worker_completed`
- `tool_started`
- `tool_completed`
- `review_started`
- `approval_required`
- `run_completed`
- `run_failed`
- `run_interrupted`
- `provider_error`
- `provider_disconnected`
- `stream_idle`

The event layer should be the source of truth for UI state. Provider adapters translate native events into these normalized events.

### Live timeline

The REPL renders a compact timeline while a run is active. It should show, at minimum:

- elapsed time
- current phase
- orchestrator model
- each active worker/tool, including model and effort where available
- worker start/completion state
- errors and warnings
- approval requests

A focused stream can continue to show live text while the timeline remains the run-level status view. The existing Tab-based worker focus remains supported.

### `/status`

`/status` becomes a unified run/account status screen rather than only a quota command. It shows:

- active run state or idle state
- current phase and elapsed duration
- active workers/tools
- provider/model/effort
- recent terminal outcome/error
- Codex/Antigravity quota information when available
- workspace and chat identifiers in a human-friendly form

A machine-readable `kumo status --json` command is added and derives its payload from the same normalized status model.

## Safety and diff-review

### Exact patch approval

Diff-review becomes a true two-phase operation. Diff-review is supported only for Git workspaces; non-Git workspaces fail with a clear error rather than falling back to prose-based validation.

1. Capture workspace baseline state.
2. Ask the worker to produce a proposed patch without applying it.
3. Store the exact patch plus metadata: workspace identity, Git baseline, preview ID, creation time, and patch hash.
4. Display the proposed patch and require approval.
5. Before applying, verify the workspace baseline has not changed in a way that invalidates the preview.
6. Validate the stored patch with `git apply --check`.
7. Apply the stored patch itself. Never re-run the natural-language implementation request after approval.
8. Re-check the resulting workspace state and report the exact applied change.

Expired, consumed, mismatched-workspace, or stale previews are rejected safely.

### Git state model

Replace filename-only snapshots with structured Git state sufficient to calculate actual changes introduced by a run. Use porcelain output with NUL delimiters so paths with spaces, Unicode, renames, and deletions are handled correctly.

The baseline must include enough information to distinguish Kumo's changes from pre-existing dirty work.

Diff statistics account for staged and unstaged changes.

## Provider contracts

Introduce a provider metadata/capability contract covering, as applicable:

- model selection
- reasoning effort
- streaming
- persistent threads/conversations
- MCP/tool use
- workspace read
- workspace write
- rate limits/quota
- interruption
- reconnect/restart behavior

The CLI and orchestration layer consult these capabilities instead of assuming arbitrary CLIs accept provider-specific flags.

Generic providers define their argument mapping explicitly. Dangerous write flags may only be emitted by adapters that declare support and are never assumed for arbitrary binaries.

Providers that lack requested capabilities must either reject the unsupported option or clearly report it as unavailable; silently accepting and ignoring a setting is not allowed.

## Configuration

Configuration is validated through one typed schema. CLI writes parse booleans, numbers, enums, and strings according to that schema.

Provider config synchronization becomes read-modify-write:

- preserve unrelated existing keys and servers
- update only Kumo-owned entries
- create files when absent
- report synchronization failures rather than silently swallowing them

Command resolution distinguishes explicit filesystem paths from commands resolved through `PATH`.

Workspace identifiers are platform-aware: case-insensitive normalization on Windows, case-preserving normalization on case-sensitive systems, and consistent realpath behavior for symlinks.

Version strings come from the package version source of truth everywhere.

## Turn termination and the abrupt-chat bug

Every started turn has exactly one terminal outcome: completed, failed, interrupted, disconnected, or timed out.

The REPL must never wait indefinitely for a `turn_completed` event. The terminal outcome is resolved by the task lifecycle rather than by one provider-specific event.

When any of the following occurs, the task lifecycle transitions to a terminal state and wakes the REPL waiter:

- provider process exits
- provider emits an unrecoverable/server error
- stdout stream closes unexpectedly
- RPC request fails or times out
- stream becomes idle beyond the configured threshold
- explicit user interrupt

Provider `close` events may trigger one reconnect attempt when safe, but reconnecting never silently abandons or retries the original run. The original run ends with a clear disconnected/failure state, the user regains the prompt, and any follow-up retry is a new run.

Streaming clients track the time of the last received stdout/event/heartbeat. The default stream-idle timeout is **120 seconds**, configurable through the typed configuration schema. Any valid progress event resets the timer. On expiry, Kumo emits `stream_idle`, terminates the provider operation when possible, records the run as timed out, and returns control to the REPL.

The UI distinguishes:

- completed normally
- interrupted by user
- provider disconnected
- provider timed out
- provider returned an error

A failed or disconnected run is never recorded as a successful completion.

## Error propagation

Provider clients normalize errors into structured terminal errors where possible while retaining raw diagnostics for debug logs.

Pending JSON-RPC requests are rejected immediately when their process closes or encounters an unrecoverable error.

Client close/error handlers are idempotent so the same failure cannot produce duplicate terminal transitions.

## Persistence and audit

Persist sufficient run metadata for completed/failed turns to support:

- session history
- `/status` recent run information
- exported session transcripts
- postmortem/debugging

The live event stream may be ring-buffered for UI purposes, but terminal run summaries do not depend on an in-memory-only buffer.

## Testing strategy

Add unit/integration tests before implementation for:

### Safety

- exact preview patch is the artifact applied after approval
- original prompt is not re-executed after approval
- stale preview is rejected
- preview for another workspace is rejected
- consumed/expired preview is rejected
- non-Git diff-review is rejected
- pre-existing dirty files do not appear as Kumo-created changes
- staged and unstaged changes are both represented
- paths with spaces and Unicode survive Git parsing
- rename/delete changes are represented correctly

### Configuration

- boolean/number/enum config parsing
- existing provider configuration is preserved
- Kumo-owned entries are updated without deleting unrelated entries
- sync failures are surfaced
- PATH-based binaries resolve correctly

### Provider contracts

- unsupported effort/capability is rejected or explicitly reported
- generic providers only receive declared arguments
- dangerous write behavior cannot be inferred for arbitrary binaries

### Abrupt termination

- process close while awaiting a turn wakes the REPL
- provider server error while awaiting a turn wakes the REPL
- stdout close while awaiting a turn wakes the REPL
- RPC pending request is rejected when the process dies
- stream idle timeout terminates a run
- provider reconnect does not leave the original run pending or silently retry it
- interruption produces an explicit interrupted terminal state
- duplicate close/error/complete signals do not double-finalize a run

### Observability

- every run has exactly one terminal lifecycle event
- worker/tool events maintain stable IDs
- timeline reflects concurrent worker activity accurately
- `/status` reflects the same lifecycle state as the live UI
- `kumo status --json` matches the normalized status model
- failed turns are not displayed as successful completions

## Delivery order

Phase 1: turn lifecycle, provider termination semantics, stream idle timeout, and regression tests for abrupt endings.

Phase 2: exact diff-review patch application and Git baseline/state model.

Phase 3: provider capability contracts and typed configuration.

Phase 4: safe configuration synchronization, binary resolution, workspace identity, and version cleanup.

Phase 5: structured event persistence plus live timeline and unified `/status`.

Phase 6: integration testing, failure injection, documentation, and cleanup.

The first implementation milestone succeeds when a provider crash, stream hang, or server error can no longer leave the interactive REPL waiting indefinitely, and diff-review approval is guaranteed to apply the reviewed artifact rather than a newly generated implementation.
