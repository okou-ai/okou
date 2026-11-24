import { currentLocale } from "../i18n/index.ts";
import { command, computed } from "ccstate";
import { billingFeedbackRewardContract } from "@okouai/api-contracts/client/billing";
import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import { accept } from "../lib/accept.ts";
import { displayBillingFeedbackSurvey } from "../lib/posthog.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedIdentity$ } from "./auth.ts";
import { pendingBillingFeedback$ } from "./billing-feedback-flow.ts";
import { billingStatusAsync$ } from "./okou-page/billing.ts";
import { isOrgAdmin$ } from "./org.ts";
import { onRef } from "./utils.ts";

export const creditsFeedbackOffer$ = computed(async (get) => {
  const status = await get(billingStatusAsync$);
  if (
    status.hasSubscription ||
    status.tier === "pro" ||
    status.tier === "team" ||
    !(await get(isOrgAdmin$))
  ) {
    return null;
  }
  await get(authenticatedIdentity$);
  const response = await accept(
    get(apiClient$)(billingFeedbackRewardContract).get(),
    [200],
  );
  return response.body.token ? response.body : null;
});

export const billingFeedbackRef$ = onRef(
  command(async ({ get }, _element: HTMLElement, signal: AbortSignal) => {
    const request = get(pendingBillingFeedback$);
    if (!request) {
      return;
    }
    const [status, identity, isAdmin] = await Promise.all([
      get(billingStatusAsync$),
      get(authenticatedIdentity$),
      get(isOrgAdmin$),
    ]);
    signal.throwIfAborted();
    if (
      !isAdmin ||
      status.hasSubscription ||
      status.tier === "pro" ||
      status.tier === "team"
    ) {
      return;
    }
    const offer =
      request.kind === "credits_exhausted"
        ? await get(creditsFeedbackOffer$)
        : null;
    signal.throwIfAborted();
    if (request.kind === "credits_exhausted" && !offer) {
      return;
    }
    displayBillingFeedbackSurvey(
      BILLING_FEEDBACK_SURVEYS[request.kind],
      {
        org_id: identity.orgId,
        billing_feedback_kind: request.kind,
        billing_attempt_id: request.id,
        ...(offer?.token ? { billing_feedback_reward_token: offer.token } : {}),
      },
      currentLocale(),
      signal,
    );
  }),
);
