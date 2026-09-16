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
interface AcquisitionSession {
  baseUrl: string;
  nextConfigurationAt: number;
  currentIdentity: string | undefined;
  sessionId: string | undefined;
  checkedSignup: boolean;
  associated: boolean;
}

function resetAssociation(scope: AcquisitionSession, identity?: string): void {
  scope.currentIdentity = identity;
  scope.sessionId = undefined;
  scope.checkedSignup = false;
  scope.associated = false;
}

const drainMarketingObservations$ = command(
  async (
    { get, set },
    scope: AcquisitionSession,
    identity: { userId: string; orgId: string },
    signal: AbortSignal,
  ) => {
    const epoch = get(marketingShadowEpoch$);
    // One association and at most three batches drain the bounded memory queue.
    for (let batch = 0; batch < 4; batch++) {
      const pending = get(pendingMarketingEvents$)
        .filter((item) => {
          return (
            item.userId === identity.userId &&
            item.orgId === identity.orgId &&
            item.event.at >= now() - 24 * 60 * 60_000
          );
        })
        .slice(0, 20);
      if (scope.associated && pending.length === 0) {
        return;
      }
      const token = await get(apiClientRuntime$).getToken(signal);
      signal.throwIfAborted();
      const activeIdentity = await get(authenticatedIdentity$);
      signal.throwIfAborted();
      if (
        !token ||
        activeIdentity.userId !== identity.userId ||
        activeIdentity.orgId !== identity.orgId ||
        get(marketingShadowEnabled$) !== true ||
        get(marketingShadowEpoch$) !== epoch
      ) {
        return;
      }
      const response = await sendMarketingObservations(
        scope.baseUrl,
        token,
        {
          checkSignup: !scope.checkedSignup,
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          events: scope.sessionId
            ? pending.map((item) => {
                return item.event;
              })
            : [],
        },
        signal,
      );
      signal.throwIfAborted();
      if (get(marketingShadowEpoch$) !== epoch) {
        return;
      }
      if (!response.shadowEnabled) {
        set(setMarketingShadowEnabled$, false);
        resetAssociation(scope);
        return;
      }
      if (!response.recorded) {
        return;
      }
      scope.associated = true;
      scope.checkedSignup = response.consented;
      if (scope.sessionId || !response.consented) {
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
        scope.sessionId = undefined;
        return;
      }
      if (!scope.sessionId) {
        // Persist only an opaque tab identity after Marketing confirms consent.
        // Referral fields and consent receipts never enter the App.
        scope.sessionId = get(session.get$) ?? crypto.randomUUID();
        set(session.set$, scope.sessionId);
      }
    }
  },
);

const synchronizeMarketingAcquisition$ = command(
  async ({ get, set }, scope: AcquisitionSession, signal: AbortSignal) => {
    const requestSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(10_000),
    ]);
    if (now() >= scope.nextConfigurationAt) {
      const config = await settle(
        marketingShadowConfiguration(scope.baseUrl, requestSignal),
        signal,
      );
      signal.throwIfAborted();
      set(setMarketingShadowEnabled$, config.ok && config.value);
      scope.nextConfigurationAt = now() + 60_000;
    }
    if (get(marketingShadowEnabled$) !== true) {
      resetAssociation(scope);
      return;
    }
    const clerk = await get(clerk$);
    signal.throwIfAborted();
    if (!clerk.user || !clerk.organization) {
      return;
    }
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const key = `${identity.userId}:${identity.orgId}`;
    if (key !== scope.currentIdentity) {
      resetAssociation(scope, key);
    }
    requestSignal.throwIfAborted();
    await set(drainMarketingObservations$, scope, identity, requestSignal);
  },
);

/** Optional observations belong to the App lifetime, independently of route readiness. */
export const setupMarketingAcquisition$ = command(
  ({ set }, signal: AbortSignal) => {
    const scope: AcquisitionSession = {
      baseUrl: resolveApiBaseForTarget("www"),
      nextConfigurationAt: 0,
      currentIdentity: undefined,
      sessionId: undefined,
      checkedSignup: false,
      associated: false,
    };
    let busy = false;
    async function synchronize(): Promise<void> {
      if (busy) {
        return;
      }
      busy = true;
      await withCleanup(
        bestEffort(
          set(synchronizeMarketingAcquisition$, scope, signal),
          signal,
        ),
        () => {
          busy = false;
        },
      );
    }
    const resume = onDomEventFn(() => {
      scope.nextConfigurationAt = 0;
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
    setLoop(
      async () => {
        await synchronize();
        return false;
      },
      10_000,
      signal,
      { testIntervalMs: 10_000 },
    );
  },
);
