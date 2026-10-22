import { cronReconcileSocialKitDownloadsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { reconcileDataSearchJobs$ } from "../services/data-search.service";
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
    const [downloads, jobs, dataJobs] = await joinAll([
      set(
        reconcileSocialKitDownloads$,
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
      set(
        reconcileDataSearchJobs$,
        AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
      ),
    ]);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, processed: downloads + jobs + dataJobs },
    };
  },
);

export const cronReconcileSocialKitDownloadRoutes: readonly RouteEntry[] = [
  {
    route: cronReconcileSocialKitDownloadsContract.reconcile,
    handler: reconcileSocialKitDownloadsRoute$,
  },
];
