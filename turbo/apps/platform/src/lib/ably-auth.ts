import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import type { AuthOptions } from "ably";
import type { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import {
  connectionDiagnosticError,
  createConnectionDiagnosticSpanId,
  publishConnectionDiagnostic,
} from "../signals/connection-diagnostics.ts";
import { detach, Reason, throwIfAbort } from "../signals/utils.ts";
import { now } from "./time.ts";
import { accept } from "./accept.ts";

type RealtimeTokenClient = InitClientReturn<
  typeof platformRealtimeTokenContract,
  InitClientArgs
>;

type AuthCallback = NonNullable<AuthOptions["authCallback"]>;

/**
 * Build an Ably `authCallback` that fetches a fresh token from the platform
 * token endpoint on every invocation.
 *
 * Ably invokes `authCallback` on the initial connect and again each time it
 * needs to renew the token (our endpoint issues tokens with a 1 h ttl).
 * The endpoint returns `TokenDetails` it already exchanged with Ably, or a
 * single-use `TokenRequest` when that exchange failed. Either must be fresh
 * on every call; caching it causes renewal to fail with "Client configured
 * authentication provider request failed".
 *
 * The factory lives outside `signals/` so it can use `detach()` to track
 * the promise (Ably's API is node-style callback, not awaitable) and
 * `try/catch` to bridge that error surface into the callback's error
 * argument — both patterns are restricted inside `signals/`.
 *
 * The fetch intentionally does NOT bind `signal` via `fetchOptions: { signal }`.
 * Aborting the fetch while MSW is still resolving the handler races MSW's
 * handler-lookup pipeline and surfaces as an "unhandled exception during the
 * handler lookup" stderr in tests. The signal is honoured at the await
 * boundary instead (`signal.throwIfAborted()`), and the catch re-throws
 * abort errors via `throwIfAbort` so `detach`'s abort-aware silencer can
 * track them — preserving the documented contract that Ably's callback is
 * not invoked once `setupRealtime$` has called `ably.close()`. The wasted
 * in-flight POST during teardown is negligible (single-shot, fast endpoint).
 */
export function createAblyAuthCallback(
  client: RealtimeTokenClient,
  signal: AbortSignal,
): AuthCallback {
  return (_params, callback) => {
    const spanId = createConnectionDiagnosticSpanId();
    const startedAtMs = now();
    publishConnectionDiagnostic({
      event: "realtime.auth-callback",
      phase: "start",
      spanId,
    });
    detach(
      (async () => {
        // eslint-disable-next-line no-restricted-syntax -- bridging Ably's node-style auth callback into our promise-based `accept()` helper; justified per eslint.config.js "If genuinely needed (JSON.parse, clipboard, polling), add an inline eslint-disable with justification"
        try {
          const res = await accept(client.create({ body: {} }), [200]);
          // The fetch above does not accept our signal, so check it
          // explicitly per ccstate skill ("AbortSignal Lifecycle"): aborts
          // surface as an AbortError that the catch re-throws to detach.
          signal.throwIfAborted();
          publishConnectionDiagnostic({
            durationMs: now() - startedAtMs,
            event: "realtime.auth-callback",
            phase: "finish",
            spanId,
          });
          callback(null, res.body);
        } catch (error) {
          // Re-throw aborts so detach silences them at the boundary —
          // Ably's callback must not be invoked after `ably.close()`.
          throwIfAbort(error);
          publishConnectionDiagnostic({
            details: connectionDiagnosticError(error),
            durationMs: now() - startedAtMs,
            event: "realtime.auth-callback",
            phase: "error",
            spanId,
          });
          callback(
            error instanceof Error ? error.message : String(error),
            null,
          );
        }
      })(),
      Reason.DomCallback,
      "ably-auth",
    );
  };
}
