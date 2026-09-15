import { command, computed, state } from "ccstate";
import type { ObservedAcquisitionEvent } from "@okouai/api-contracts/contracts/impact-marketing";
import { authenticatedIdentity$ } from "../auth.ts";
import { now } from "../../lib/time.ts";
import { IN_VITEST } from "../../env.ts";
import { setLoop } from "../utils.ts";

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
export const flushMarketingEvent$ = command(
  async ({ get }, id: string, signal: AbortSignal) => {
    let attempts = 0;
    await setLoop(
      () => {
        attempts += 1;
        return (
          !get(pendingMarketingEvents$).some((entry) => {
            return entry.event.id === id;
          }) || attempts >= (IN_VITEST ? 2 : 20)
        );
      },
      100,
      signal,
      { retryTransientErrors: false },
    );
  },
);
