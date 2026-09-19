/**
 * turn-wait.js — Shared terminal-state detection for an orchestrator turn.
 *
 * Orchestrator clients signal the end of a turn in three mutually exclusive
 * ways: `turn_completed` (success), `server_error` (the transport or provider
 * failed mid-turn), or `close` (the child process exited). Waiting on only the
 * first of those deadlocks the caller whenever one of the other two fires,
 * which is exactly the REPL lockup this helper exists to prevent.
 */

/** Default ceiling when the caller supplies no timeout. */
export const DEFAULT_TURN_TIMEOUT_MS = 300000;

/**
 * Wait for a turn to reach a terminal state.
 *
 * @param {import("node:events").EventEmitter} client
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {{ok?: boolean}} [opts.startTurnResult] - value returned by `startTurn`;
 *   clients that complete a turn synchronously (GenericAppClient) already carry
 *   the outcome and must not be waited on a second time.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export function awaitTurnCompletion(client, opts = {}) {
  const { timeoutMs = DEFAULT_TURN_TIMEOUT_MS, startTurnResult } = opts;

  if (startTurnResult && typeof startTurnResult.ok === "boolean") {
    return Promise.resolve(
      startTurnResult.ok ? { ok: true } : { ok: false, reason: startTurnResult.reason || "turn failed" }
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      client.off?.("turn_completed", onCompleted);
      client.off?.("server_error", onError);
      client.off?.("close", onClose);
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        cleanup();
      } finally {
        fn(value);
      }
    };

    const onCompleted = () => finish(resolve, { ok: true });
    const onError = (err) =>
      finish(resolve, { ok: false, reason: err?.message || String(err ?? "server error") });
    const onClose = (code) => finish(resolve, { ok: false, reason: `exited (code ${code})` });

    client.on("turn_completed", onCompleted);
    client.on("server_error", onError);
    client.on("close", onClose);

    if (timeoutMs > 0) {
      timer = setTimeout(
        () => finish(reject, new Error(`Turn timed out after ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs
      );
      timer.unref?.();
    }
  });
}
