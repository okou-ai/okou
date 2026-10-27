import { cronCleanupSuggestionsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { cleanupSuggestions$ } from "../services/cron-cleanup-suggestions.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const cleanupSuggestionsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const body = await set(cleanupSuggestions$, signal);
    return { status: 200 as const, body };
  },
);

export const cronCleanupSuggestionsRoutes: readonly RouteEntry[] = [
  {
    route: cronCleanupSuggestionsContract.cleanup,
    handler: cleanupSuggestionsRoute$,
  },
];
