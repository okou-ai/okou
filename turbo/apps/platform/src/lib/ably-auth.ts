import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/client/types";
import type { AuthOptions } from "ably";
import type { platformRealtimeTokenContract } from "@okouai/api-contracts/contracts/realtime";
import { detach, Reason, throwIfAbort } from "../signals/utils.ts";
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
 * Connection teardown cancels token acquisition and suppresses the callback.
 */
export function createAblyAuthCallback(
  createClient: () => RealtimeTokenClient,
  rootSignal: AbortSignal,
): AuthCallback {
  return (_params, callback) => {
    detach(
      (async () => {
        // eslint-disable-next-line no-restricted-syntax -- bridging Ably's node-style auth callback into our promise-based `accept()` helper; justified per eslint.config.js "If genuinely needed (JSON.parse, clipboard, polling), add an inline eslint-disable with justification"
        try {
          rootSignal.throwIfAborted();
          const client = createClient();
          const res = await accept(
            client.create({ body: {}, fetchOptions: { signal: rootSignal } }),
            [200],
            rootSignal,
          );
          rootSignal.throwIfAborted();
          callback(null, res.body);
        } catch (error) {
          throwIfAbort(error);
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
