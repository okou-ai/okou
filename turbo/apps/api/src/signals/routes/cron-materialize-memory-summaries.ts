import { cronMaterializeMemorySummariesContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import { executeMemorySummaryProjectionWork$ } from "../services/memory-summary-projection.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const materializeMemorySummariesRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(
      executeMemorySummaryProjectionWork$,
      { currentTime: nowDate() },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronMaterializeMemorySummariesRoutes: readonly RouteEntry[] = [
  {
    route: cronMaterializeMemorySummariesContract.materialize,
    handler: materializeMemorySummariesRoute$,
  },
];
