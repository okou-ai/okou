import { cronCleanupXResourceReadsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { cleanupXResourceReads$ } from "../services/cron-cleanup-x-resource-reads.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const cleanupXResourceReadsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const deleted = await set(cleanupXResourceReads$, signal);
    return { status: 200 as const, body: { deleted } };
  },
);

export const cronCleanupXResourceReadsRoutes: readonly RouteEntry[] = [
  {
    route: cronCleanupXResourceReadsContract.cleanup,
    handler: cleanupXResourceReadsRoute$,
  },
];
