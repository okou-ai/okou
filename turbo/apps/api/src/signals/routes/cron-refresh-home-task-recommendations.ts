import { cronRefreshHomeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { refreshDueHomeTaskRecommendations$ } from "../services/home-task-recommendations.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const refresh$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const body = await set(refreshDueHomeTaskRecommendations$, signal);
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

export const cronRefreshHomeTaskRecommendationsRoutes: readonly RouteEntry[] = [
  {
    route: cronRefreshHomeTaskRecommendationsContract.refresh,
    handler: refresh$,
  },
];
