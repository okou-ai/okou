import { command } from "ccstate";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import type { RouteEntry } from "../route-entry";
import { executeDurableUserExportWork$ } from "../services/user-export-durable.service";
import { cleanupDurableUserExports$ } from "../services/user-export-cleanup.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const process$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
  const cleaned = await set(cleanupDurableUserExports$, {}, workSignal);
  signal.throwIfAborted();
  const result = await set(executeDurableUserExportWork$, {}, workSignal);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { ...result, cleaned: cleaned.processed },
  };
});

export const cronProcessBackgroundJobsRoutes: readonly RouteEntry[] = [
  { route: cronProcessBackgroundJobsContract.process, handler: process$ },
];
