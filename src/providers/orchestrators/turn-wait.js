/**
 * turn-wait.js — Shared terminal-state detection for an orchestrator turn.
 *
 * Orchestrator clients signal the end of a turn in three mutually exclusive
 * ways: `turn_completed` (with an optional `{ ok, reason }` payload),
 * `server_error` (the transport or provider failed mid-turn), or `close` (the
 * child process exited). Waiting on only the first of those deadlocks the
 * caller whenever one of the other two fires.
 */

/**
 * Default ceiling when the caller supplies no timeout. A turn may dispatch
 * several worker calls of up to `timeoutMs` (5 min) each, so it must be well
 * above the per-worker limit.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/** How long `interrupt()` waits for the client to confirm before giving up. */
export const DEFAULT_INTERRUPT_GRACE_MS = 5000;

/**
 * Map a `turn_completed` payload onto an outcome. Clients report failure as
 * `{ ok: false, reason }`; an absent payload means success.
 *
 * @param {unknown} payload
 * @returns {{ ok: boolean, reason?: string }}
 */
function completionOutcome(payload) {
  if (payload && typeof payload === "object" && payload.ok === false) {
    return { ok: false, reason: payload.reason || "turn failed" };
  }
  return { ok: true };
}

/**
 * Run one orchestrator turn from submission to a terminal state.
 *
 * The terminal-event listeners are attached *before* `start()` runs: Codex can
 * deliver `turn/completed` in the same stdout chunk as the `turn/start`
 * response, and a listener attached after `startTurn` resolves misses it and
 * waits out the whole timeout. The turn ends only on an event, never on
 * `startTurn`'s return value, because some clients (Antigravity) return as
 * soon as the prompt is written.
 *
 * On timeout or `interrupt()`, the client is asked to stop the turn and given
 * `graceMs` to confirm; `done` settles either way, so the caller can safely
 * accept new input afterwards.
 *
 * @param {import("node:events").EventEmitter & { interruptTurn?: () => Promise<void> }} client
 * @param {() => unknown} start - submits the turn (usually `() => client.startTurn(...)`)
 * @param {{ timeoutMs?: number, graceMs?: number }} [opts]
 * @returns {{
 *   done: Promise<{ ok: boolean, reason?: string, timedOut?: boolean, interrupted?: boolean }>,
 *   interrupt: (reason?: string) => void,
 * }}
 */
export function runTurn(client, start, opts = {}) {
  const { timeoutMs = DEFAULT_TURN_TIMEOUT_MS, graceMs = DEFAULT_INTERRUPT_GRACE_MS } = opts;

  let settled = false;
  let timer = null;
  let graceTimer = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  // Set once the turn is being stopped, so the terminal event that follows is
  // reported as the interruption or timeout that caused it.
  let stopping = null;
  const stoppedOutcome = () => ({
    ok: false,
    reason: stopping.reason,
    ...(stopping.timedOut ? { timedOut: true } : { interrupted: true }),
  });

  const cleanup = () => {
    clearTimeout(timer);
    clearTimeout(graceTimer);
    client.off?.("turn_completed", onCompleted);
    client.off?.("server_error", onError);
    client.off?.("close", onClose);
  };

  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveDone(outcome);
  };

  function onCompleted(payload) {
    finish(stopping ? stoppedOutcome() : completionOutcome(payload));
  }
  function onError(err) {
    if (!stopping && !settled) {
      // The orchestrator may still be working; stop it before the caller
      // accepts the next prompt, so the two turns cannot interleave.
      Promise.resolve()
        .then(() => client.interruptTurn?.())
        .catch(() => {});
    }
    finish(stopping ? stoppedOutcome() : { ok: false, reason: err?.message || String(err ?? "server error") });
  }
  function onClose(code) {
    finish(stopping ? stoppedOutcome() : { ok: false, reason: `exited (code ${code})` });
  }

  const stop = (reason, timedOut) => {
    if (settled || stopping) return;
    stopping = { reason, timedOut };
    clearTimeout(timer);
    Promise.resolve()
      .then(() => client.interruptTurn?.())
      .catch(() => {});
    // Not every client confirms an interrupt with an event; never hang on it.
    graceTimer = setTimeout(() => finish(stoppedOutcome()), graceMs);
  };

  client.on("turn_completed", onCompleted);
  client.on("server_error", onError);
  client.on("close", onClose);

  if (timeoutMs > 0) {
    // Deliberately NOT unref'd. An unref'd timer lets the event loop drain
    // while the turn is still pending, so it would neither complete nor time
    // out — the caller just never hears back. `cleanup()` clears it on every
    // settle path, so it cannot outlive the turn.
    timer = setTimeout(
      () => stop(`Turn timed out after ${Math.round(timeoutMs / 1000)}s`, true),
      timeoutMs
    );
  }

  Promise.resolve()
    .then(start)
    .catch((err) => finish({ ok: false, reason: err?.message || String(err) }));

  return { done, interrupt: (reason = "Interrupted by user") => stop(reason, false) };
}
