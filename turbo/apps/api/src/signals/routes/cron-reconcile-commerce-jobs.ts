import { cronReconcileCommerceJobsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { reconcileCommerceJobs$ } from "../services/commerce-job.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const reconcile$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const processed = await set(reconcileCommerceJobs$, signal);
  signal.throwIfAborted();
  return { status: 200 as const, body: { success: true as const, processed } };
});

export const cronReconcileCommerceJobRoutes: readonly RouteEntry[] = [
  { route: cronReconcileCommerceJobsContract.reconcile, handler: reconcile$ },
];
