import { command, computed, state } from "ccstate";
import type { ObservedAcquisitionEvent } from "@okouai/api-contracts/contracts/marketing-acquisition";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { authenticatedIdentity$ } from "../auth.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { now } from "../../lib/time.ts";

interface PendingEvent {
  userId: string;
  orgId: string;
  event: ObservedAcquisitionEvent;
}
// Business observations only. No URL attribution, cookies, or provider SDKs.
const internalPendingMarketingEvents$ = state<readonly PendingEvent[]>([]);
const internalMarketingShadowEpoch$ = state(0);
export const marketingShadowEpoch$ = computed((get) => {
  return get(internalMarketingShadowEpoch$);
});
export const marketingShadowEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.MarketingAcquisitionShadow];
});
export const discardMarketingEvents$ = command(({ set }) => {
  set(internalMarketingShadowEpoch$, (epoch) => {
    return epoch + 1;
  });
  set(internalPendingMarketingEvents$, []);
});
export const pendingMarketingEvents$ = computed((get) => {
  return get(internalPendingMarketingEvents$);
});
export const acknowledgeMarketingEvents$ = command(
  ({ set }, ids: ReadonlySet<string>) => {
    set(internalPendingMarketingEvents$, (previous) => {
      return previous.filter((entry) => {
        return !ids.has(entry.event.id);
      });
    });
  },
);
export const enqueueMarketingEvent$ = command(
  async (
    { get, set },
    name: ObservedAcquisitionEvent["name"],
    properties: ObservedAcquisitionEvent["properties"],
    signal: AbortSignal,
  ) => {
    if (!get(marketingShadowEnabled$)) {
      return undefined;
    }
    const at = now();
    const epoch = get(marketingShadowEpoch$);
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    if (!get(marketingShadowEnabled$) || get(marketingShadowEpoch$) !== epoch) {
      return undefined;
    }
    const event: ObservedAcquisitionEvent = {
      id: crypto.randomUUID(),
      name,
      at,
      properties,
    };
    set(internalPendingMarketingEvents$, (previous) => {
      return [...previous.slice(-49), { ...identity, event }];
    });
    window.dispatchEvent(new Event("okou:acquisition:queued"));
    return event.id;
  },
);
