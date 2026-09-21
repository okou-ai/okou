import { cronReconcileSocialKitDownloadsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { joinAll } from "../utils";
import {
  reconcileSocialDataJobs$,
  SOCIAL_DATA_RECONCILIATION_TIMEOUT_MS,
} from "../services/social-data.service";
import {
  reconcileSocialKitDownloads$,
  SOCIALKIT_RECONCILIATION_TIMEOUT_MS,
} from "../services/socialkit-download.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const reconcileSocialKitDownloadsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }
    const [downloads, jobs] = await joinAll([
      set(
        reconcileSocialKitDownloads$,
        {},
        AbortSignal.any([
          signal,
          AbortSignal.timeout(SOCIALKIT_RECONCILIATION_TIMEOUT_MS),
        ]),
      ),
      set(
        reconcileSocialDataJobs$,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(SOCIAL_DATA_RECONCILIATION_TIMEOUT_MS),
        ]),
      ),
    ]);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, processed: downloads + jobs },
    };
  },
);

export const cronReconcileSocialKitDownloadRoutes: readonly RouteEntry[] = [
  {
    route: cronReconcileSocialKitDownloadsContract.reconcile,
    handler: reconcileSocialKitDownloadsRoute$,
  },
];
