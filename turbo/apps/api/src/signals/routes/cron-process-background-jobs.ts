import { command } from "ccstate";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import type { RouteEntry } from "../route-entry";
import { executeDurableUserExportWork$ } from "../services/user-export-durable.service";
import { cleanupDurableUserExports$ } from "../services/user-export-cleanup.service";
import {
  cleanupOnboardingRecommendationJobs$,
  executeOnboardingRecommendationWork$,
} from "../services/onboarding-recommendation.service";
import { executeClerkUserDeletionWork$ } from "../services/clerk-user-deletion-job.service";
import { drainUsageChatProjection$ } from "../services/usage-chat-projection-worker.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const process$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
  const [cleanedExports, cleanedRecommendations] = await Promise.all([
    set(cleanupDurableUserExports$, {}, workSignal),
    set(cleanupOnboardingRecommendationJobs$, {}, workSignal),
  ]);
  signal.throwIfAborted();
  // Each kind owns a disjoint queue, so a long export cannot keep a fresh
  // onboarding result from using the same durable wakeup.
  const [exports, recommendations, deletions, chatUsage] = await Promise.all([
    set(executeDurableUserExportWork$, {}, workSignal),
    set(executeOnboardingRecommendationWork$, { maxJobs: 1 }, workSignal),
    set(executeClerkUserDeletionWork$, {}, workSignal),
    set(drainUsageChatProjection$, { maxJobs: 10 }, workSignal),
  ]);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      processed:
        exports.processed +
        recommendations.processed +
        deletions.processed +
        chatUsage.processed,
      cleaned: cleanedExports.processed + cleanedRecommendations.processed,
    },
  };
});

export const cronProcessBackgroundJobsRoutes: readonly RouteEntry[] = [
  { route: cronProcessBackgroundJobsContract.process, handler: process$ },
];
