import { bestEffort } from "../utils.ts";
import { command } from "ccstate";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";
import {
  billingRedeemCodeContract,
  billingUsagePackCheckoutContract,
} from "@okouai/api-contracts/contracts/billing";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { reloadAgents$ } from "../agent.ts";
import { authenticatedIdentity$ } from "../auth.ts";
import { ROUTES } from "../route-paths.ts";
import { billingStatusAsync$ } from "../okou-page/billing.ts";
import { readStoredAdAttributionMetadata$ } from "../bootstrap/ad-attribution.ts";
import { reloadOnboardingStatus$ } from "../okou-page/onboarding.ts";
import {
  ONBOARDING_CHECKOUT_STATE_PARAM,
  onboardingDraft$,
  resetOnboardingDraft$,
  storeOnboardingCheckoutDraft$,
} from "./onboarding-state.ts";
import {
  capturePaidOnboardingCheckoutCreated$,
  capturePaidOnboardingRedirectToStripe$,
  capturePaidOnboardingRoleConfirmed$,
} from "../bootstrap/paid-funnel-telemetry.ts";
import { completeGoogleAdsPaidCheckout$ } from "../bootstrap/google-ads-paid-conversion.ts";

export const completeOnboarding$ = command(
  async (
    { get, set },
    redeemCode: string | null,
    signal: AbortSignal,
  ): Promise<void> => {
    const createClient = get(apiClient$);
    const draft = get(onboardingDraft$);
    const role = draft.choice === "workflow" ? draft.categoryId : null;
    if (redeemCode) {
      const redeemClient = createClient(billingRedeemCodeContract);
      await accept(
        redeemClient.create({
          body: { code: redeemCode },
          fetchOptions: { signal },
        }),
        [200],
      );
      signal.throwIfAborted();
    }

    const onboardingClient = createClient(onboardingCompleteContract);
    const timezone =
      new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    await accept(
      onboardingClient.complete({
        body: { timezone },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (role) {
      set(capturePaidOnboardingRoleConfirmed$, role);
    }
    // Both a prior route and the Worker's HTML prefetch can retain an empty
    // list from before the status endpoint provisioned the default agent.
    set(reloadAgents$);
    set(reloadOnboardingStatus$);
    set(resetOnboardingDraft$);
  },
);

type OnboardingVideoRunResult = "run" | "checkout";

interface OnboardingVideoCheckoutInput {
  readonly prompt: string;
  readonly note: string;
  readonly templateId: string;
  readonly templateSlug: string;
}

function checkoutReturnUrl(
  input: OnboardingVideoCheckoutInput,
  result: "pro" | "canceled",
  checkoutState: string,
): string {
  const url = new URL(ROUTES.onboardingVideoRun, window.location.origin);
  const params = new URLSearchParams();
  params.set("choice", "video");
  params.set("template", input.templateId);
  params.set("onboarding_template", input.templateSlug);
  params.set(ONBOARDING_CHECKOUT_STATE_PARAM, checkoutState);
  params.set("onboarding_billing", result);
  if (result === "pro") {
    params.set("onboarding_billing_session_id", "{CHECKOUT_SESSION_ID}");
  } else {
    params.delete("onboarding_billing_session_id");
  }
  url.search = params.toString();
  return url
    .toString()
    .replace(
      "onboarding_billing_session_id=%7BCHECKOUT_SESSION_ID%7D",
      "onboarding_billing_session_id={CHECKOUT_SESSION_ID}",
    );
}

export const prepareOnboardingVideoRun$ = command(
  async (
    { get, set },
    input: OnboardingVideoCheckoutInput,
    signal: AbortSignal,
  ): Promise<OnboardingVideoRunResult> => {
    const billing = await get(billingStatusAsync$);
    signal.throwIfAborted();
    if (billing.tier === "pro" || billing.tier === "team") {
      return "run";
    }

    const checkoutState = set(storeOnboardingCheckoutDraft$, {
      prompt: input.prompt,
      note: input.note,
    });
    const adAttribution = set(readStoredAdAttributionMetadata$);
    const successUrl = checkoutReturnUrl(input, "pro", checkoutState);
    const cancelUrl = checkoutReturnUrl(input, "canceled", checkoutState);
    const { userId } = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const client = get(apiClient$)(billingUsagePackCheckoutContract);
    const result = await accept(
      client.create({
        body: {
          tier: "pro",
          memberUsagePacks: [{ memberId: userId, usagePackUsd: 20 }],
          successUrl,
          cancelUrl,
          ...(adAttribution === undefined ? {} : { adAttribution }),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    if (!("url" in result.body)) {
      throw new Error("Onboarding checkout unexpectedly returned a preview");
    }
    const checkoutUrl = result.body.url;
    set(capturePaidOnboardingCheckoutCreated$, "onboarding_video");
    await bestEffort(
      set(capturePaidOnboardingRedirectToStripe$, "onboarding_video", signal),
      signal,
    );
    window.location.href = checkoutUrl;
    return "checkout";
  },
);

export const completeOnboardingCheckoutReturn$ = command(
  async ({ set }, sessionId: string, signal: AbortSignal): Promise<void> => {
    await set(
      completeGoogleAdsPaidCheckout$,
      { sessionId, kind: "paid_in_onboarding" },
      signal,
    );
  },
);
