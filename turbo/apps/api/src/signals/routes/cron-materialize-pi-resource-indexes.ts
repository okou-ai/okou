import { cronMaterializePiResourceIndexesContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { executePiResourceIndexWork$ } from "../services/pi-resource-version-index.service";
import { executePiStableContextWork } from "../services/pi-stable-context.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";
import { writeDb$ } from "../external/db";

const materializePiResourceIndexes$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const result = await set(executePiResourceIndexWork$, undefined, signal);
    signal.throwIfAborted();
    const stableContext = await executePiStableContextWork(
      set(writeDb$),
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result, stableContext },
    };
  },
);

export const cronMaterializePiResourceIndexesRoutes: readonly RouteEntry[] = [
  {
    route: cronMaterializePiResourceIndexesContract.materialize,
    handler: materializePiResourceIndexes$,
  },
];
