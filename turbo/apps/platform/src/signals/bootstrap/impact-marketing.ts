import { timeout } from "signal-timers";
import { command } from "ccstate";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { authenticatedIdentity$ } from "../auth.ts";
import {
  pendingMarketingEvents$,
  acknowledgeMarketingEvents$,
} from "./marketing-events.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import {
  onRef,
  createDeferredPromise,
  withCleanup,
  settle,
  setLoop,
} from "../utils.ts";

function waitForMessage(
  frame: HTMLIFrameElement,
  origin: string,
  type: string,
  nonce: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const deferred = createDeferredPromise<boolean>(signal);
  const finish = (value: boolean) => {
    if (!deferred.settled()) {
      deferred.resolve(value);
    }
  };
  const listener = (event: MessageEvent<unknown>) => {
    if (event.origin !== origin || event.source !== frame.contentWindow) {
      return;
    }
    const data = event.data as { type?: unknown; nonce?: unknown } | null;
    const ready =
      type === "okou:acquisition:ready" && data?.type === "okou:impact:ready";
    if (
      (data?.type === type || ready) &&
      (nonce === undefined || data?.nonce === nonce)
    ) {
      finish(true);
    }
  };
  timeout(
    () => {
      finish(false);
    },
    type === "okou:acquisition:complete" ? 15_000 : 60_000,
    { signal },
  );
  const queued = () => {
    finish(true);
  };
  if (type === "okou:acquisition:ready" && frame.src) {
    window.addEventListener("okou:acquisition:queued", queued);
  }
  window.addEventListener("message", listener);
  return withCleanup(deferred.promise, () => {
    window.removeEventListener("message", listener);
    window.removeEventListener("okou:acquisition:queued", queued);
  });
}

const runImpactHandoff$ = command(
  async ({ get, set }, frame: HTMLIFrameElement, signal: AbortSignal) => {
    const client = get(apiClient$)(impactMarketingContract, {
      apiBase: "api",
    });
    let loaded = false;
    let checkedSignupUserId: string | undefined;
    while (!signal.aborted) {
      const identity = await get(authenticatedIdentity$);
      signal.throwIfAborted();
      const pending = get(pendingMarketingEvents$)
        .filter((entry) => {
          return (
            entry.userId === identity.userId && entry.orgId === identity.orgId
          );
        })
        .slice(0, 2);
      const response = await accept(
        client.handoff({
          body: {
            acquisition: {
              version: 2,
              checkSignup: checkedSignupUserId !== identity.userId,
              events: pending.map((entry) => {
                return entry.event;
              }),
            },
          },
          fetchOptions: {
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          },
        }),
        [200],
      );
      signal.throwIfAborted();
      const proof = response.body.handoff;
      if (!proof) {
        return;
      }
      const origin = new URL(proof.iframeUrl).origin;
      if (!loaded) {
        const ready = waitForMessage(
          frame,
          origin,
          "okou:acquisition:ready",
          undefined,
          signal,
        );
        frame.src = proof.iframeUrl;
        loaded = await ready;
        signal.throwIfAborted();
        if (!loaded) {
          continue;
        }
      }
      const complete = waitForMessage(
        frame,
        origin,
        "okou:acquisition:complete",
        proof.nonce,
        signal,
      );
      frame.contentWindow?.postMessage(
        {
          type: "okou:impact:identify",
          token: proof.token,
          nonce: proof.nonce,
        },
        origin,
      );
      const recorded = await complete;
      signal.throwIfAborted();
      if (recorded) {
        checkedSignupUserId = identity.userId;
        const ids = new Set(
          pending.map((entry) => {
            return entry.event.id;
          }),
        );
        set(acknowledgeMarketingEvents$, ids);
        if (
          get(pendingMarketingEvents$).some((entry) => {
            return (
              entry.userId === identity.userId && entry.orgId === identity.orgId
            );
          })
        ) {
          continue;
        }
      }
      // Keep the bridge alive for returning subscribers and consent changes.
      // The timer also renews expired identity proofs after transient failures.
      await waitForMessage(
        frame,
        origin,
        "okou:acquisition:ready",
        undefined,
        signal,
      );
      signal.throwIfAborted();
    }
  },
);

export const setImpactMarketingFrame$ = onRef(
  command(async ({ set }, frame: HTMLIFrameElement, signal: AbortSignal) => {
    await setLoop(
      async (loopSignal) => {
        const result = await settle(
          set(runImpactHandoff$, frame, loopSignal),
          loopSignal,
        );
        loopSignal.throwIfAborted();
        return result.ok;
      },
      30_000,
      signal,
      { testIntervalMs: 30_000, logTransientErrors: false },
    );
  }),
);
