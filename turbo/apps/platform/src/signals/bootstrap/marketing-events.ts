import { command, computed, state } from "ccstate";
import type { ObservedAcquisitionEvent } from "@okouai/api-contracts/contracts/marketing-acquisition";
import { authenticatedIdentity$ } from "../auth.ts";
import { now } from "../../lib/time.ts";

interface PendingEvent {
  userId: string;
  orgId: string;
  event: ObservedAcquisitionEvent;
}
// Business observations only. No URL attribution, cookies, or provider SDKs.
const internalPendingMarketingEvents$ = state<readonly PendingEvent[]>([]);
// Unknown buffers only business observations in memory until the Marketing config endpoint
// supplies Marketing's runtime setting. A known disabled state discards them.
const internalMarketingShadowEnabled$ = state<boolean | undefined>(undefined);
const internalMarketingShadowEpoch$ = state(0);
export const marketingShadowEpoch$ = computed((get) => {
  return get(internalMarketingShadowEpoch$);
});
export const marketingShadowEnabled$ = computed((get) => {
  return get(internalMarketingShadowEnabled$);
});
export const setMarketingShadowEnabled$ = command(
  ({ set }, enabled: boolean | undefined) => {
    set(internalMarketingShadowEnabled$, enabled);
    if (enabled !== true) {
      set(internalMarketingShadowEpoch$, (epoch) => {
        return epoch + 1;
      });
      set(internalPendingMarketingEvents$, []);
    }
  },
);
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
    if (get(marketingShadowEnabled$) === false) {
      return undefined;
    }
    const at = now();
    const epoch = get(marketingShadowEpoch$);
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    if (
      get(marketingShadowEnabled$) === false ||
      get(marketingShadowEpoch$) !== epoch
    ) {
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
