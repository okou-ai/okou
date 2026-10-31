import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/client/types";
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
  createClient: () => RealtimeTokenClient,
  rootSignal: AbortSignal,
): AuthCallback {
  return (_params, callback) => {
    const signal = abortAfter(5000, rootSignal);
    detach(
      (async () => {
        // eslint-disable-next-line no-restricted-syntax -- bridging Ably's node-style auth callback into our promise-based `accept()` helper; justified per eslint.config.js "If genuinely needed (JSON.parse, clipboard, polling), add an inline eslint-disable with justification"
        try {
          signal.throwIfAborted();
          const client = createClient();
          // eslint-disable-next-line ccstate/no-on-rejection -- 存量 2026/10/21: distinguish an authentication timeout from root cancellation.
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
          signal.throwIfAborted();
          callback(null, res.body);
        } catch (error) {
          throwIfAbort(error);
          // Connection teardown suppresses callbacks; a per-invocation
          // deadline must instead finish Ably's pending authentication.
          rootSignal.throwIfAborted();
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
