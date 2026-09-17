import { cronPruneStoragePresignedUrlsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { pruneStoragePresignedUrlCache$ } from "../services/cron-prune-storage-presigned-urls.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const pruneStoragePresignedUrlCacheRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(pruneStoragePresignedUrlCache$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronPruneStoragePresignedUrlsRoutes: readonly RouteEntry[] = [
  {
    route: cronPruneStoragePresignedUrlsContract.prune,
    handler: pruneStoragePresignedUrlCacheRoute$,
  },
];
