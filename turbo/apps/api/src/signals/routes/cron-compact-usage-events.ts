import { cronCompactUsageEventsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { compactUsageEvents$ } from "../services/cron-compact-usage-events.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const compactUsageEventsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(compactUsageEvents$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronCompactUsageEventsRoutes: readonly RouteEntry[] = [
  {
    route: cronCompactUsageEventsContract.compact,
    handler: compactUsageEventsRoute$,
  },
];
