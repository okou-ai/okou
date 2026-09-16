import { now } from "../../lib/time.ts";
import { command } from "ccstate";
import {
  marketingShadowConfiguration,
  sendMarketingObservations,
} from "../../lib/marketing-acquisition.ts";
import { authenticatedIdentity$, clerk$ } from "../auth.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import {
  bestEffort,
  onDomEventFn,
  setLoop,
  settle,
  withCleanup,
} from "../utils.ts";
import {
  acknowledgeMarketingEvents$,
  marketingShadowEnabled$,
  marketingShadowEpoch$,
  pendingMarketingEvents$,
  setMarketingShadowEnabled$,
} from "./marketing-events.ts";

const session = sessionStorageSignals("okou.acquisitionSession");

/** Optional observations belong to the App lifetime, independently of route readiness. */
export const setupMarketingAcquisition$ = command(
  ({ get, set }, signal: AbortSignal) => {
    const baseUrl = resolveApiBaseForTarget("www");
    let busy = false;
    let nextConfigurationAt = 0;
    let currentIdentity: string | undefined;
    let sessionId: string | undefined;
    let checkedSignup = false;
    let associated = false;

    async function run(): Promise<void> {
      const requestSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(10_000),
      ]);
      if (now() >= nextConfigurationAt) {
        const config = await settle(
          marketingShadowConfiguration(baseUrl, requestSignal),
          signal,
        );
        signal.throwIfAborted();
        set(setMarketingShadowEnabled$, config.ok && config.value);
        nextConfigurationAt = now() + 60_000;
      }
      if (get(marketingShadowEnabled$) !== true) {
        currentIdentity = undefined;
        sessionId = undefined;
        checkedSignup = false;
        associated = false;
        return;
      }
      const clerk = await get(clerk$);
      requestSignal.throwIfAborted();
      if (!clerk.user || !clerk.organization) return;
      const identity = await get(authenticatedIdentity$);
      requestSignal.throwIfAborted();
      const key = `${identity.userId}:${identity.orgId}`;
      if (key !== currentIdentity) {
        currentIdentity = key;
        sessionId = undefined;
        checkedSignup = false;
        associated = false;
      }
      const epoch = get(marketingShadowEpoch$);
      // One association and at most three batches drain the bounded in-memory queue.
      for (let batch = 0; batch < 4; batch++) {
        const pending = get(pendingMarketingEvents$)
          .filter((item) => {
            return (
              item.userId === identity.userId && item.orgId === identity.orgId
            );
          })
          .slice(0, 20);
        if (associated && pending.length === 0) return;
        const token = await get(apiClientRuntime$).getToken(requestSignal);
        requestSignal.throwIfAborted();
        const activeIdentity = await get(authenticatedIdentity$);
        requestSignal.throwIfAborted();
        if (
          !token ||
          activeIdentity.userId !== identity.userId ||
          activeIdentity.orgId !== identity.orgId ||
          get(marketingShadowEnabled$) !== true ||
          get(marketingShadowEpoch$) !== epoch
        )
          return;
        const response = await sendMarketingObservations(
          baseUrl,
          token,
          {
            checkSignup: !checkedSignup,
            ...(sessionId ? { sessionId } : {}),
            events: sessionId
              ? pending.map((item) => {
                  return item.event;
                })
              : [],
          },
          requestSignal,
        );
        requestSignal.throwIfAborted();
        if (get(marketingShadowEpoch$) !== epoch) return;
        if (!response.shadowEnabled) {
          set(setMarketingShadowEnabled$, false);
          currentIdentity = undefined;
          return;
        }
        if (!response.recorded) return;
        associated = true;
        checkedSignup = response.consented;
        if (sessionId || !response.consented) {
          set(
            acknowledgeMarketingEvents$,
            new Set(
              pending.map((item) => {
                return item.event.id;
              }),
            ),
          );
        }
        if (!response.consented) {
          set(session.clear$);
          sessionId = undefined;
          return;
        }
        if (!sessionId) {
          // Persist only an opaque tab identity, after Marketing confirms consent.
          // Referral fields and consent receipts never enter the App.
          sessionId = get(session.get$) ?? crypto.randomUUID();
          set(session.set$, sessionId);
        }
      }
    }
    async function synchronize(): Promise<void> {
      if (busy) return;
      busy = true;
      await withCleanup(bestEffort(run(), signal), () => {
        busy = false;
      });
    }
    const resume = onDomEventFn(() => {
      nextConfigurationAt = 0;
      return synchronize();
    });
    window.addEventListener(
      "okou:acquisition:queued",
      onDomEventFn(synchronize),
      { signal },
    );
    window.addEventListener("focus", resume, { signal });
    window.addEventListener("online", resume, { signal });
    // Recheck the runtime flag every minute and retry unacknowledged batches.
    setLoop(synchronize, 10_000, signal, { testIntervalMs: 10_000 });
  },
);
