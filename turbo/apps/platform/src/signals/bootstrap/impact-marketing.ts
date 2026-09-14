import { timeout } from "signal-timers";
import { command } from "ccstate";
import { impactMarketingContract } from "@okouai/api-contracts/contracts/impact-marketing";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import {
  onRef,
  createDeferredPromise,
  withCleanup,
  settle,
  setLoop,
} from "../utils.ts";
import { recordImpactAttribution$ } from "./impact-attribution.ts";

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
    if (data?.type === type && (nonce === undefined || data.nonce === nonce)) {
      finish(true);
    }
  };
  timeout(
    () => {
      finish(false);
    },
    type === "okou:impact:complete" ? 15_000 : 60_000,
    { signal },
  );
  window.addEventListener("message", listener);
  return withCleanup(deferred.promise, () => {
    window.removeEventListener("message", listener);
  });
}

const runImpactHandoff$ = command(
  async ({ get, set }, frame: HTMLIFrameElement, signal: AbortSignal) => {
    // Clears the retired App session value once the migration switch is active.
    set(recordImpactAttribution$);
    const client = get(apiClient$)(impactMarketingContract, {
      apiBase: "api",
    });
    let loaded = false;
    while (!signal.aborted) {
      const response = await accept(
        client.handoff({
          body: {},
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
          "okou:impact:ready",
          undefined,
          signal,
        );
        frame.src = proof.iframeUrl;
        await ready;
        signal.throwIfAborted();
        loaded = true;
      }
      const complete = waitForMessage(
        frame,
        origin,
        "okou:impact:complete",
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
      if (await complete) {
        signal.throwIfAborted();
        await accept(
          client.sync({
            body: {},
            fetchOptions: {
              signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
            },
          }),
          [200],
        );
        signal.throwIfAborted();
      }
      // Keep the bridge alive for returning subscribers and consent changes.
      // The timer also renews expired identity proofs after transient failures.
      await waitForMessage(
        frame,
        origin,
        "okou:impact:ready",
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
