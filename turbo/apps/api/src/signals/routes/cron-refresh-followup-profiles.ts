import { cronRefreshFollowupProfilesContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { refreshFollowupProfiles } from "../services/chat-followup-preferences.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const refreshFollowupProfiles$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const result = await refreshFollowupProfiles(
      set(writeDb$),
      undefined,
      signal,
    );
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronRefreshFollowupProfilesRoutes: readonly RouteEntry[] = [
  {
    route: cronRefreshFollowupProfilesContract.refresh,
    handler: refreshFollowupProfiles$,
  },
];
