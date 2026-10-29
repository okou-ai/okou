import { recoverLinkApprovalWorkflows$ } from "../services/link-approval-workflow.service";
import { command } from "ccstate";
import { cronProcessBackgroundJobsContract } from "@okouai/api-contracts/contracts/cron";
import type { RouteEntry } from "../route-entry";
import { executeDurableUserExportWork$ } from "../services/user-export-durable.service";
import { cleanupDurableUserExports$ } from "../services/user-export-cleanup.service";
import {
  cleanupOnboardingRecommendationJobs$,
  executeOnboardingRecommendationWork$,
} from "../services/onboarding-recommendation.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";
import { cleanupWorkflowAttachments$ } from "../services/workflow-attachment-cleanup.service";
import { continueModelBusyChats$ } from "../services/chat-model-busy-retry.service";

const process$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
  const [cleanedExports, cleanedRecommendations] = await Promise.all([
    set(cleanupDurableUserExports$, workSignal),
    set(cleanupOnboardingRecommendationJobs$, {}, workSignal),
  ]);
  signal.throwIfAborted();
  // Each kind owns a disjoint queue, so a long export cannot keep a fresh
  // onboarding result from using the same durable wakeup.
  const [exports, recommendations, approvals, attachments, busyChats] =
    await Promise.all([
      set(executeDurableUserExportWork$, {}, workSignal),
      set(executeOnboardingRecommendationWork$, { maxJobs: 1 }, workSignal),
      set(recoverLinkApprovalWorkflows$, workSignal),
      set(cleanupWorkflowAttachments$, workSignal),
      set(continueModelBusyChats$, workSignal),
    ]);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      processed:
        exports.processed +
        recommendations.processed +
        approvals +
        attachments +
        busyChats,
      cleaned: cleanedExports.processed + cleanedRecommendations.processed,
    },
  };
});

export const cronProcessBackgroundJobsRoutes: readonly RouteEntry[] = [
  { route: cronProcessBackgroundJobsContract.process, handler: process$ },
];
