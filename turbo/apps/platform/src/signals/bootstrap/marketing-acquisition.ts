import { now } from "../../lib/time.ts";
import { command } from "ccstate";
import { sendMarketingObservations } from "../../lib/marketing-acquisition.ts";
import { authenticatedIdentity$, clerk$ } from "../auth.ts";
import { apiClientRuntime$ } from "../api-client-runtime.ts";
import { resolveApiBaseForTarget } from "../api-base.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { registerFeatureSwitchListener$ } from "../external/feature-switch-state.ts";
import {
  bestEffort,
  onDomEventFn,
  resetSignal,
  setLoop,
  withCleanup,
} from "../utils.ts";
import {
  acknowledgeMarketingEvents$,
  discardMarketingEvents$,
  marketingShadowEnabled$,
  marketingShadowEpoch$,
  pendingMarketingEvents$,
} from "./marketing-events.ts";

const session = sessionStorageSignals("okou.acquisitionSession");
const resetMarketingAcquisition$ = resetSignal();
interface AcquisitionSession {
  baseUrl: string;
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
  ({ get, set }, signal: AbortSignal) => {
    const scope: AcquisitionSession = {
      baseUrl: resolveApiBaseForTarget("www"),
      currentIdentity: undefined,
      sessionId: undefined,
      checkedSignup: false,
      associated: false,
    };
    let activeSignal: AbortSignal | undefined;
    let busy = false;
    async function synchronize(): Promise<void> {
      const requestSignal = activeSignal;
      if (busy || !requestSignal || requestSignal.aborted) {
        return;
      }
      busy = true;
      await withCleanup(
        bestEffort(
          set(synchronizeMarketingAcquisition$, scope, requestSignal),
          requestSignal,
        ),
        () => {
          busy = false;
        },
      );
    }
    function reconcile(): void {
      const enabled = get(marketingShadowEnabled$);
      if (enabled === Boolean(activeSignal && !activeSignal.aborted)) {
        return;
      }
      const nextSignal = set(resetMarketingAcquisition$, signal);
      resetAssociation(scope);
      activeSignal = enabled ? nextSignal : undefined;
      if (!enabled) {
        set(discardMarketingEvents$);
        return;
      }
      // Retry unacknowledged observations only while the App switch is enabled.
      setLoop(
        async () => {
          await synchronize();
          return false;
        },
        10_000,
        nextSignal,
        { testIntervalMs: 10_000 },
      );
    }
    const resume = onDomEventFn(synchronize);
    window.addEventListener(
      "okou:acquisition:queued",
      onDomEventFn(synchronize),
      { signal },
    );
    window.addEventListener("focus", resume, { signal });
    window.addEventListener("online", resume, { signal });
    set(registerFeatureSwitchListener$, reconcile, signal);
    reconcile();
  },
);
