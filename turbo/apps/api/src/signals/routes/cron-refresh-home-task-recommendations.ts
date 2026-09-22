import { cronRefreshHomeTaskRecommendationsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  refreshDueHomeTaskRecommendations,
  type HomeTaskScope,
} from "../services/home-task-recommendations.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

function createRefreshHomeTaskRecommendationsRoute(
  onlyScope?: HomeTaskScope,
): RouteEntry["handler"] {
  return command(async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const body = await refreshDueHomeTaskRecommendations(
      set(writeDb$),
      get(clerk$),
      onlyScope,
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body };
  });
}

function routesFor(handler: RouteEntry["handler"]): readonly RouteEntry[] {
  return [
    {
      route: cronRefreshHomeTaskRecommendationsContract.refresh,
      handler,
    },
  ];
}

export const cronRefreshHomeTaskRecommendationsRoutes = routesFor(
  createRefreshHomeTaskRecommendationsRoute(),
);

/** Test-only owner scoping while retaining the deployed cron route boundary. */
export function createScopedHomeTaskRecommendationCronRoutesForTest(
  scope: HomeTaskScope,
): readonly RouteEntry[] {
  return routesFor(createRefreshHomeTaskRecommendationsRoute(scope));
}
