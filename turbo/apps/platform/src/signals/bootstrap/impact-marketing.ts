import { timeout } from "signal-timers";
import { command } from "ccstate";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { authenticatedIdentity$ } from "../auth.ts";
import {
  pendingMarketingEvents$,
  acknowledgeMarketingEvents$,
  marketingShadowEnabled$,
  setMarketingShadowEnabled$,
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
    const data = event.data as {
      type?: unknown;
      nonce?: unknown;
      shadowEnabled?: unknown;
    } | null;
    if (
      type === "okou:acquisition:complete" &&
      data?.type === "okou:acquisition:ready" &&
      data.shadowEnabled !== true
    ) {
      finish(false);
      return;
    }
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

function waitForReadyMessage(
  frame: HTMLIFrameElement,
  origin: string,
  signal: AbortSignal,
): Promise<boolean> {
  return waitForMessage(
    frame,
    origin,
    "okou:acquisition:ready",
    undefined,
    signal,
  );
}

function listenForShadowConfiguration(
  frame: HTMLIFrameElement,
  getOrigin: () => string | undefined,
  onEnabled: (enabled: boolean) => void,
): () => void {
  const listener = (event: MessageEvent<unknown>) => {
    const origin = getOrigin();
    if (
      !origin ||
      event.origin !== origin ||
      event.source !== frame.contentWindow
    ) {
      return;
    }
    const data = event.data as {
      type?: unknown;
      shadowEnabled?: unknown;
    } | null;
    if (data?.type === "okou:acquisition:ready") {
      onEnabled(data.shadowEnabled === true);
    }
  };
  window.addEventListener("message", listener);
  return () => {
    window.removeEventListener("message", listener);
  };
}

function matchesIdentity(
  entry: { userId: string; orgId: string },
  identity: { userId: string; orgId: string },
): boolean {
  return entry.userId === identity.userId && entry.orgId === identity.orgId;
}

const runImpactHandoff$ = command(
  async ({ get, set }, frame: HTMLIFrameElement, signal: AbortSignal) => {
    const client = get(apiClient$)(impactMarketingContract, {
      apiBase: "api",
    });
    let loaded = false;
    let checkedSignupUserId: string | undefined;
    let trustedOrigin: string | undefined;
    let revision = 0;
    const stopConfiguration = listenForShadowConfiguration(
      frame,
      () => {
        return trustedOrigin;
      },
      (enabled) => {
        if (enabled !== get(marketingShadowEnabled$)) {
          revision += 1;
          checkedSignupUserId = undefined;
          set(setMarketingShadowEnabled$, enabled);
        }
      },
    );
    await withCleanup(
      (async () => {
        while (!signal.aborted) {
          const identity = await get(authenticatedIdentity$);
          signal.throwIfAborted();
          const shadowEnabled = get(marketingShadowEnabled$) === true;
          const requestRevision = revision;
          const pending = (shadowEnabled ? get(pendingMarketingEvents$) : [])
            .filter((entry) => {
              return matchesIdentity(entry, identity);
            })
            .slice(0, 2);
          const response = await accept(
            client.handoff({
              body: shadowEnabled
                ? {
                    acquisition: {
                      version: 2,
                      checkSignup: checkedSignupUserId !== identity.userId,
                      events: pending.map((entry) => {
                        return entry.event;
                      }),
                    },
                  }
                : {},
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
          trustedOrigin = origin;
          if (!loaded) {
            const ready = waitForReadyMessage(frame, origin, signal);
            frame.src = proof.iframeUrl;
            loaded = await ready;
            signal.throwIfAborted();
            if (!loaded) {
              continue;
            }
          }
          // A proof requested before a switch change must not replay its observations.
          if (shadowEnabled && revision !== requestRevision) {
            continue;
          }
          const complete = shadowEnabled
            ? waitForMessage(
                frame,
                origin,
                "okou:acquisition:complete",
                proof.nonce,
                signal,
              )
            : Promise.resolve(false);
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
          if (
            recorded &&
            get(marketingShadowEnabled$) === true &&
            revision === requestRevision
          ) {
            checkedSignupUserId = identity.userId;
            const ids = new Set(
              pending.map((entry) => {
                return entry.event.id;
              }),
            );
            set(acknowledgeMarketingEvents$, ids);
            if (
              get(pendingMarketingEvents$).some((entry) => {
                return matchesIdentity(entry, identity);
              })
            ) {
              continue;
            }
          }
          if (
            revision !== requestRevision &&
            (shadowEnabled || get(marketingShadowEnabled$) === true)
          ) {
            continue;
          }
          // Keep the bridge alive for returning subscribers and consent changes.
          // The timer also renews expired identity proofs after transient failures.
          await waitForReadyMessage(frame, origin, signal);
          signal.throwIfAborted();
        }
      })(),
      stopConfiguration,
    );
  },
);

export const setImpactMarketingFrame$ = onRef(
  command(async ({ set }, frame: HTMLIFrameElement, signal: AbortSignal) => {
    await withCleanup(
      setLoop(
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
      ),
      () => {
        set(setMarketingShadowEnabled$, undefined);
      },
    );
  }),
);
