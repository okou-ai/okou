import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

import type { PiAgentServiceTier } from "./types";
import type { PiObservedServiceTier } from "./api-types";
import type { PiUsageObserver } from "./usage-observation";

/** Internal extension consumed by Pi's native OpenAI Responses adapter. */
export interface PiAgentStreamOptions extends SimpleStreamOptions {
  readonly usageObserver?: PiUsageObserver;
  readonly onObservedServiceTier?: (serviceTier: PiObservedServiceTier) => void;
  readonly onObservedResponseStatus?: (status: number) => void;
  readonly serviceTier?: PiAgentServiceTier;
}

/** Observe only status; preserve the adapter's own fetch and network policy. */
export function observePiResponseStatus(
  fetchImpl: NonNullable<SimpleStreamOptions["fetch"]>,
  observe: PiAgentStreamOptions["onObservedResponseStatus"],
): NonNullable<SimpleStreamOptions["fetch"]> {
  if (!observe) return fetchImpl;
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    observe(response.status);
    return response;
  };
}
