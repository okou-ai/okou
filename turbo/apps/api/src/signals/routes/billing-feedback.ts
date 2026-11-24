import { timingSafeEqual } from "node:crypto";
import { billingFeedbackRewardContract } from "@okouai/api-contracts/contracts/billing";
import { posthogSurveysContract } from "@okouai/api-contracts/contracts/posthog-surveys";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import { command, computed } from "ccstate";
import { env } from "../../lib/env";
import {
  signBillingFeedbackOffer,
  verifyBillingFeedbackOffer,
} from "../../lib/billing-feedback-token";
import { notConfigured } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { getMemberRoleAndUpdateCache$ } from "../services/auth.service";
import {
  billingFeedbackRewardEligible,
  BILLING_FEEDBACK_REWARD_CREDITS,
  grantBillingFeedbackReward$,
} from "../services/billing-feedback-reward.service";
import { publishBillingChangedForOrg$ } from "../services/billing-realtime.service";

const rewardIdentity$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    canManageBilling: auth.orgRole === "admin",
  };
});
const rewardEligible$ = billingFeedbackRewardEligible(rewardIdentity$);
const rewardEventBody$ = bodyResultOf(posthogSurveysContract.reward);

const rewardOfferAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    const eligible = await get(rewardEligible$);
    signal.throwIfAborted();
    const auth = get(organizationAuthContext$);
    const token = eligible
      ? signBillingFeedbackOffer({ orgId: auth.orgId, userId: auth.userId })
      : null;
    return {
      status: 200 as const,
      body: {
        rewardCredits: token ? BILLING_FEEDBACK_REWARD_CREDITS : 0,
        token,
      },
    };
  },
);

const rewardOffer$ = authRoute(
  { requireOrganization: true, missingOrganizationStatus: 401 },
  rewardOfferAuthed$,
);

const rewardWebhook$ = command(async ({ get, set }, signal: AbortSignal) => {
  const secret = env("BILLING_FEEDBACK_WEBHOOK_SECRET");
  if (!secret) {
    return notConfigured("PostHog reward settlement is not configured");
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(get(authorization$) ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "Invalid PostHog destination credential",
    );
  }
  const body = await get(rewardEventBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const event = body.data;
  const properties = event.properties;
  if (
    properties.$survey_id !== BILLING_FEEDBACK_SURVEYS.credits_exhausted ||
    !properties.$survey_completed
  ) {
    return { status: 200 as const, body: { rewardCredits: 0 } };
  }
  const offer = properties.billing_feedback_reward_token
    ? verifyBillingFeedbackOffer(properties.billing_feedback_reward_token)
    : null;
  if (
    !offer ||
    offer.orgId !== properties.org_id ||
    offer.userId !== event.distinct_id
  ) {
    return createErrorResponse("UNAUTHORIZED", "Invalid feedback reward offer");
  }
  const membership = await set(
    getMemberRoleAndUpdateCache$,
    offer.orgId,
    offer.userId,
    signal,
  );
  if (membership.kind !== "member" || membership.role !== "admin") {
    return { status: 200 as const, body: { rewardCredits: 0 } };
  }
  const rewardCredits = await set(grantBillingFeedbackReward$, offer, signal);
  // Re-notify on redelivery as well: a previous grant may have committed before
  // its notification failed. This does not repeat the financial write.
  await set(publishBillingChangedForOrg$, offer.orgId);
  signal.throwIfAborted();
  return { status: 200 as const, body: { rewardCredits } };
});

export const billingFeedbackRoutes: readonly RouteEntry[] = [
  { route: billingFeedbackRewardContract.get, handler: rewardOffer$ },
  {
    route: posthogSurveysContract.reward,
    handler: rewardWebhook$,
    requestBodyPolicy: {
      maxBytes: 16 * 1024,
      tooLargeMessage: "PostHog reward event is too large",
    },
  },
];
