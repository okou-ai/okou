import { command } from "ccstate";
import { cronReconcileImageGenerationsContract } from "@okouai/api-contracts/contracts/cron";
import type { RouteEntry } from "../route-entry";
import { reconcileOpenAiImageJobs$ } from "../services/openai-image-generation.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const process$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const result = await set(reconcileOpenAiImageJobs$, signal);
  return { status: 200 as const, body: result };
});

export const cronReconcileImageGenerationsRoutes: readonly RouteEntry[] = [
  { route: cronReconcileImageGenerationsContract.process, handler: process$ },
];
