import { command, state } from "ccstate";
import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import { IN_VITEST } from "../../../env.ts";
import { apiClient$ } from "../../api-client.ts";
import { isConnectorChangedPayloadFor } from "../../connector-change.ts";
import type { PlatformConnectorAccountMutationIntent } from "../../connector-domain.ts";
import { waitAblyPayloadLoopUntil$ } from "../../realtime.ts";
import { resetKeyedSignal, waitLoopUntil, withCleanup } from "../../utils.ts";
import { readConnectorOAuthCompletion } from "./connector-accounts.ts";

async function waitForPopupClosed(
  authWindow: Pick<Window, "closed">,
  signal: AbortSignal,
): Promise<void> {
  await waitLoopUntil(
    () => {
      return authWindow.closed;
    },
    IN_VITEST ? 10 : 250,
    signal,
  );
  signal.throwIfAborted();
}

interface OAuthCompletionTarget {
  readonly connectorSlug: ConnectorSlug;
  readonly account: PlatformConnectorAccountMutationIntent;
  readonly oauthAttemptId: string;
  readonly authWindow: Window | null;
}

interface OAuthCompletionAttempt extends OAuthCompletionTarget {
  readonly waitSignal: AbortSignal;
  readonly connectionId: string | null;
}

// Only live authorization waiters are retained. Their exact signals route
// realtime callbacks without sharing state between connectors or retries.
const completionAttempts$ = state<ReadonlyMap<symbol, OAuthCompletionAttempt>>(
  new Map(),
);
const resetWaitSignal$ = resetKeyedSignal<symbol>();

const refreshCompletion$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    for (const [id, attempt] of get(completionAttempts$)) {
      if (attempt.waitSignal !== signal) {
        continue;
      }
      if (attempt.connectionId !== null) {
        return true;
      }
      const connectionId = await readConnectorOAuthCompletion(
        get(apiClient$),
        { kind: "builtin", connectorSlug: attempt.connectorSlug },
        attempt.account,
        attempt.oauthAttemptId,
        signal,
      );
      signal.throwIfAborted();
      const current = get(completionAttempts$);
      if (current.get(id)?.waitSignal !== signal) {
        return false;
      }
      if (connectionId !== null) {
        set(
          completionAttempts$,
          new Map(current).set(id, { ...attempt, connectionId }),
        );
      }
      return connectionId !== null;
    }
    return false;
  },
);

const onConnectorChanged$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    for (const attempt of get(completionAttempts$).values()) {
      if (attempt.waitSignal === signal) {
        return isConnectorChangedPayloadFor(payload, attempt.connectorSlug)
          ? await set(refreshCompletion$, signal)
          : false;
      }
    }
    return false;
  },
);

const releaseCompletion$ = command(({ get, set }, id: symbol) => {
  const current = get(completionAttempts$);
  if (current.has(id)) {
    const remaining = new Map(current);
    remaining.delete(id);
    set(completionAttempts$, remaining);
  }
  set(resetWaitSignal$, id);
});

/** Each authorization window owns its completion readback and realtime waiter. */
export const waitForBuiltinConnectorOAuthCompletion$ = command(
  async ({ get, set }, target: OAuthCompletionTarget, signal: AbortSignal) => {
    signal.throwIfAborted();
    const id = Symbol();
    const waitSignal = set(resetWaitSignal$, id, signal);
    set(completionAttempts$, (current) => {
      return new Map(current).set(id, {
        ...target,
        waitSignal,
        connectionId: null,
      });
    });
    const release = () => {
      set(releaseCompletion$, id);
    };
    signal.addEventListener("abort", release, { once: true });
    return await withCleanup(
      (async () => {
        const changed = set(
          waitAblyPayloadLoopUntil$,
          {
            topic: "connector:changed",
            loopCommand$: onConnectorChanged$,
            initializeCommand$: refreshCompletion$,
          },
          waitSignal,
        );
        await withCleanup(
          target.authWindow === null
            ? changed
            : Promise.race([
                changed,
                waitForPopupClosed(target.authWindow, waitSignal),
              ]),
          () => {
            set(resetWaitSignal$, id);
          },
        );
        signal.throwIfAborted();
        const connectionId =
          get(completionAttempts$).get(id)?.connectionId ?? null;
        if (connectionId !== null) {
          return connectionId;
        }
        // Popup closure can precede its notification. Confirm the exact OAuth
        // attempt against the API before treating it as canceled.
        return await readConnectorOAuthCompletion(
          get(apiClient$),
          { kind: "builtin", connectorSlug: target.connectorSlug },
          target.account,
          target.oauthAttemptId,
          signal,
        );
      })(),
      () => {
        signal.removeEventListener("abort", release);
        release();
      },
    );
  },
);
