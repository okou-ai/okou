import { currentLocale } from "../i18n/index.ts";
import { command, computed } from "ccstate";
import { billingFeedbackRewardContract } from "@okouai/api-contracts/client/billing";
import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import { accept } from "../lib/accept.ts";
import { displayBillingFeedbackSurvey } from "../lib/posthog.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedIdentity$ } from "./auth.ts";
import {
  consumeBillingFeedback$,
  pendingBillingFeedback$,
  requestBillingFeedback$,
} from "./billing-feedback-flow.ts";
import {
  billingStatusAsync$,
  handleBillingRedirect$,
} from "./okou-page/billing.ts";
import { settingsDialogSessionActive$ } from "./okou-page/settings/settings-dialog-session.ts";
import { isOrgAdmin$ } from "./org.ts";
import { searchParams$ } from "./route.ts";
import { resetSignal } from "./utils.ts";

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

const resetFeedbackSignal$ = resetSignal();

/** Click, redirect and dialog-close events own survey initiation. */
export const showPendingBillingFeedback$ = command(
  async ({ get, set }, ownerSignal: AbortSignal) => {
    if (
      get(settingsDialogSessionActive$) ||
      get(searchParams$).has("settings")
    ) {
      return;
    }
    const request = get(pendingBillingFeedback$);
    if (!request) {
      return;
    }
    const signal = set(resetFeedbackSignal$, ownerSignal);
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
    if (!set(consumeBillingFeedback$, request.id)) {
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
  },
);

export const handleBillingFeedbackRedirect$ = command(
  async ({ set }, signal: AbortSignal) => {
    await set(handleBillingRedirect$, signal);
    signal.throwIfAborted();
    // The initial Stripe return precedes page setup and belongs to app startup.
    await set(showPendingBillingFeedback$, signal);
  },
);

export const requestCreditsFeedback$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(requestBillingFeedback$, "credits_exhausted");
    await set(showPendingBillingFeedback$, signal);
  },
);
