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
import { deliverMarketingRewardProjections$ } from "../services/marketing-reward-projection.service";
import { deliverMarketingRewardEvents$ } from "../services/marketing-reward-event-delivery.service";
import { captureMarketingInvitationAuthority$ } from "../services/marketing-invitation-observation.service";
import { prepareMarketingRewardSources$ } from "../services/marketing-reward-source-preparation.service";
import { queryOf } from "../context/request";
import { env } from "../../lib/env";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";

const process$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const workSignal = AbortSignal.any([signal, AbortSignal.timeout(50_000)]);
  const query = get(queryOf(cronProcessBackgroundJobsContract.process));
  if (query.marketingRewardsOnly === "true") {
    if (
      !env("MARKETING_REWARDS_EVENTS_ORIGIN") ||
      !env("MARKETING_REWARDS_EVENTS_SECRET")
    ) {
      return createErrorResponse(
        "EVENT_DELIVERY_UNAVAILABLE",
        "Reward source delivery is not configured",
      );
    }
    const body = await set(
      prepareMarketingRewardSources$,
      query.maxRewardEvents ?? 25,
      workSignal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body };
  }
  const [cleanedExports, cleanedRecommendations] = await Promise.all([
    set(cleanupDurableUserExports$, workSignal),
    set(cleanupOnboardingRecommendationJobs$, {}, workSignal),
  ]);
  signal.throwIfAborted();
  // Each kind owns a disjoint queue, so a long export cannot keep a fresh
  // onboarding result from using the same durable wakeup.
  const [
    exports,
    recommendations,
    approvals,
    attachments,
    rewardEvents,
    rewardProjections,
    invitationObservations,
  ] = await Promise.all([
    set(executeDurableUserExportWork$, {}, workSignal),
    set(executeOnboardingRecommendationWork$, { maxJobs: 1 }, workSignal),
    set(recoverLinkApprovalWorkflows$, workSignal),
    set(cleanupWorkflowAttachments$, workSignal),
    set(deliverMarketingRewardEvents$, {}, workSignal),
    set(deliverMarketingRewardProjections$, workSignal),
    set(captureMarketingInvitationAuthority$, {}, workSignal),
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
        rewardEvents.processed +
        rewardProjections +
        invitationObservations.processed,
      cleaned: cleanedExports.processed + cleanedRecommendations.processed,
    },
  };
});

export const cronProcessBackgroundJobsRoutes: readonly RouteEntry[] = [
  { route: cronProcessBackgroundJobsContract.process, handler: process$ },
];
