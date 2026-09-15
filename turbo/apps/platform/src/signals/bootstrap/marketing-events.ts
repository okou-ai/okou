import { command, computed, state } from "ccstate";
import type { ObservedAcquisitionEvent } from "@okouai/api-contracts/contracts/impact-marketing";
import { authenticatedIdentity$ } from "../auth.ts";
import { now } from "../../lib/time.ts";

interface PendingEvent {
  userId: string;
  orgId: string;
  event: ObservedAcquisitionEvent;
}
// Business observations only. No URL attribution, cookies, or provider SDKs.
const internalPendingMarketingEvents$ = state<readonly PendingEvent[]>([]);
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
    const at = now();
    const identity = await get(authenticatedIdentity$);
    signal.throwIfAborted();
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
