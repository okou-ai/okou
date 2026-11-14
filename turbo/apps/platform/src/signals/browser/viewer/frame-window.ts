import { command, computed, state } from "ccstate";
import { monotonicNow } from "../../../lib/time.ts";
import type { CdpClient } from "../cdp/client.ts";
import { CdpFault } from "../cdp/errors.ts";

const sampleCount = 3;
const frameRateBudget = 30;
const minimumWindow = 3;
const maximumWindow = 24;

async function meanRoundTrip(
  client: CdpClient,
  signal: AbortSignal,
): Promise<number> {
  await client.opened;
  signal.throwIfAborted();
  let total = 0;
  for (let sample = 0; sample < sampleCount; sample++) {
    const started = monotonicNow();
    await client.request(
      "Browser.getVersion",
      undefined,
      undefined,
      undefined,
      signal,
    );
    signal.throwIfAborted();
    total += monotonicNow() - started;
  }
  return total / sampleCount;
}

/** One frame socket owns its estimate; sampling never gates capture readiness. */
export function createFrameWindow(client: CdpClient) {
  const mean$ = state<number | null>(null);
  const maxFramesInFlight$ = computed((get) => {
    const mean = get(mean$);
    if (mean === null) {
      return minimumWindow;
    }
    // Reserve two slots for encoding/scheduling beyond the measured round trip.
    return Math.min(
      maximumWindow,
      Math.max(minimumWindow, Math.ceil((frameRateBudget * mean) / 1000) + 2),
    );
  });
  const measure$ = command(async ({ set }, signal: AbortSignal) => {
    const [result] = await Promise.allSettled([meanRoundTrip(client, signal)]);
    signal.throwIfAborted();
    if (result.status === "rejected") {
      // An optional read cannot make an otherwise usable viewer unavailable.
      if (result.reason instanceof CdpFault) {
        return;
      }
      throw result.reason;
    }
    set(mean$, result.value);
  });
  return { client, maxFramesInFlight$, measure$ };
}
