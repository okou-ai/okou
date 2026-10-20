import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import type { AuthOptions } from "ably";
import type { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import {
  abortAfter,
  detach,
  onRejection,
  Reason,
  throwIfAbort,
} from "../signals/utils.ts";
import { accept } from "./accept.ts";
import type { AblyAuthDiagnosticScope } from "./ably-auth-diagnostics.ts";
import {
  createAuthDiagnosticId,
  recordAuthDiagnostic,
  startAuthDiagnosticMeasurement,
  type AuthDiagnosticContext,
} from "./auth-diagnostics.ts";

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
 * The endpoint returns a signed, single-use `TokenRequest`, which the Ably
 * SDK exchanges for a token. Fetch a fresh request on every call; caching it
 * causes renewal to fail with "Client configured authentication provider
 * request failed".
 *
 * The factory lives outside `signals/` so it can use `detach()` to track
 * the promise (Ably's API is node-style callback, not awaitable) and
 * `try/catch` to bridge that error surface into the callback's error
 * argument — both patterns are restricted inside `signals/`.
 *
 * Each invocation has a five-second budget shared by token acquisition and
 * HTTP through the existing cancellation-aware token and request pipeline.
 * Report a deadline failure to Ably before its own ten-second timeout, but
 * never invoke its callback after the connection's root signal aborts.
 */
export function createAblyAuthCallback(
  createClient: (diagnostic: AuthDiagnosticContext) => RealtimeTokenClient,
  scope: AblyAuthDiagnosticScope,
  rootSignal: AbortSignal,
): AuthCallback {
  return (_params, callback) => {
    const signal = abortAfter(5000, rootSignal);
    const invocation: AuthDiagnosticContext = {
      ...scope.context,
      ablyAuthId: createAuthDiagnosticId(),
    };
    const measurement = startAuthDiagnosticMeasurement();
    recordAuthDiagnostic({
      stage: "ably_auth_started",
      context: invocation,
      outcome: "started",
    });
    detach(
      (async () => {
        let previousContext: AuthDiagnosticContext | undefined;
        let enteredCallback = false;
        // eslint-disable-next-line no-restricted-syntax -- bridging Ably's node-style auth callback into our promise-based `accept()` helper; justified per eslint.config.js "If genuinely needed (JSON.parse, clipboard, polling), add an inline eslint-disable with justification"
        try {
          signal.throwIfAborted();
          const client = createClient(invocation);
          const res = await onRejection(
            async () => {
              const response = await accept(
                client.create({ body: {}, fetchOptions: { signal } }),
                [200],
                signal,
              );
              signal.throwIfAborted();
              return response;
            },
            () => {
              rootSignal.throwIfAborted();
              if (signal.aborted) {
                // Downstream waits cancel with AbortError, but Ably still
                // needs its callback completed for this invocation's deadline.
                throw new Error("Ably authentication timed out");
              }
            },
          );
          recordAuthDiagnostic({
            stage: "ably_auth_api_finished",
            context: invocation,
            measurement,
            status: res.status,
            ownerAborted: signal.aborted,
          });
          signal.throwIfAborted();
          recordAuthDiagnostic({
            stage: "ably_auth_callback",
            context: invocation,
          });
          // The SDK enters its exchange plugin synchronously inside callback.
          // Restore this scope even if the SDK callback throws or re-enters;
          // each request captures its own context before awaiting any I/O.
          previousContext = scope.callbackContext;
          scope.callbackContext = invocation;
          enteredCallback = true;
          callback(null, res.body);
        } catch (error) {
          throwIfAbort(error);
          // Connection teardown suppresses callbacks; a per-invocation
          // deadline must instead finish Ably's pending authentication.
          rootSignal.throwIfAborted();
          recordAuthDiagnostic({
            stage: "ably_auth_callback",
            context: invocation,
            measurement,
            ownerAborted: signal.aborted,
            outcome: signal.aborted ? "aborted" : "error",
          });
          callback(
            error instanceof Error ? error.message : String(error),
            null,
          );
        } finally {
          if (enteredCallback) {
            scope.callbackContext = previousContext;
          }
        }
      })(),
      Reason.DomCallback,
      "ably-auth",
    );
  };
}
