// One-question billing surveys, asked where a member is closest to paying.
import { command, computed, state } from "ccstate";
import { billingSurveyContract } from "@okouai/api-contracts/client/billing";
import type {
  BillingSurveyCheckoutKind,
  BillingSurveyKind,
  BillingSurveyRequest,
} from "@okouai/api-contracts/contracts/billing";
import {
  CHECKOUT_ABANDONED_SURVEY_ANSWERS,
  CREDITS_EXHAUSTED_SURVEY_ANSWERS,
} from "@okouai/api-contracts/validators/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedIdentity$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { billingCheckoutCanceled$ } from "./billing-checkout-return.ts";
import { reloadBillingStatus$ } from "./okou-page/billing.ts";

export type CreditsExhaustedSurveyAnswer =
  (typeof CREDITS_EXHAUSTED_SURVEY_ANSWERS)[number];
export type CheckoutAbandonedSurveyAnswer =
  (typeof CHECKOUT_ABANDONED_SURVEY_ANSWERS)[number];
export { CHECKOUT_ABANDONED_SURVEY_ANSWERS, CREDITS_EXHAUSTED_SURVEY_ANSWERS };

const DETAIL_MAX_LENGTH = 500;

export const billingSurveyEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.BillingSurvey] === true;
});

const statusReload$ = state(0);

const billingSurveyStatus$ = computed(async (get) => {
  get(statusReload$);
  if (!get(billingSurveyEnabled$)) {
    return null;
  }
  const checkoutCanceled = await get(billingCheckoutCanceled$);
  await get(authenticatedIdentity$);
  const client = get(apiClient$)(billingSurveyContract);
  const result = await accept(
    client.status({
      query: checkoutCanceled ? { checkoutReturn: "canceled" } : {},
    }),
    [200],
  );
  return result.body;
});

function surveyAnswered(
  status: { readonly answered: readonly BillingSurveyKind[] } | null,
  survey: BillingSurveyKind,
): boolean {
  return status === null || status.answered.includes(survey);
}

/** The thank-you credits on offer, or null when this survey is not asked. */
export const creditsExhaustedSurveyReward$ = computed(async (get) => {
  const status = await get(billingSurveyStatus$);
  if (!status || surveyAnswered(status, "credits_exhausted")) {
    return null;
  }
  return status.creditsExhaustedReward;
});

// ---------------------------------------------------------------------------
// Answer drafts
// ---------------------------------------------------------------------------

interface SurveyDraft<Answer extends string> {
  readonly answer: Answer | null;
  readonly detail: string;
}

const EMPTY_DRAFT = Object.freeze({ answer: null, detail: "" });

const internalCreditsExhaustedDraft$ =
  state<SurveyDraft<CreditsExhaustedSurveyAnswer>>(EMPTY_DRAFT);
const internalCheckoutAbandonedDraft$ =
  state<SurveyDraft<CheckoutAbandonedSurveyAnswer>>(EMPTY_DRAFT);
/** Credits granted by the answer just submitted from this page. */
const internalCreditsExhaustedThanks$ = state<{
  readonly rewardCredits: number;
} | null>(null);

export const creditsExhaustedDraft$ = computed((get) => {
  return get(internalCreditsExhaustedDraft$);
});
export const checkoutAbandonedDraft$ = computed((get) => {
  return get(internalCheckoutAbandonedDraft$);
});
export const creditsExhaustedThanks$ = computed((get) => {
  return get(internalCreditsExhaustedThanks$);
});

export const updateCreditsExhaustedDraft$ = command(
  ({ set }, next: Partial<SurveyDraft<CreditsExhaustedSurveyAnswer>>) => {
    set(internalCreditsExhaustedDraft$, (previous) => {
      return { ...previous, ...next };
    });
  },
);
export const updateCheckoutAbandonedDraft$ = command(
  ({ set }, next: Partial<SurveyDraft<CheckoutAbandonedSurveyAnswer>>) => {
    set(internalCheckoutAbandonedDraft$, (previous) => {
      return { ...previous, ...next };
    });
  },
);

function draftDetail(
  draft: SurveyDraft<string>,
): { readonly detail: string } | Record<string, never> {
  const detail = draft.detail.trim().slice(0, DETAIL_MAX_LENGTH);
  return draft.answer === "other" && detail.length > 0 ? { detail } : {};
}

const submitSurvey$ = command(
  async ({ get, set }, body: BillingSurveyRequest, signal: AbortSignal) => {
    const client = get(apiClient$)(billingSurveyContract);
    const result = await accept(
      client.submit({ body, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(statusReload$, (value) => {
      return value + 1;
    });
    return result.body;
  },
);

export const submitCreditsExhaustedSurvey$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const draft = get(internalCreditsExhaustedDraft$);
    if (!draft.answer) {
      return;
    }
    const result = await set(
      submitSurvey$,
      {
        survey: "credits_exhausted",
        answer: draft.answer,
        ...draftDetail(draft),
      },
      signal,
    );
    set(internalCreditsExhaustedThanks$, {
      rewardCredits: result.rewardCredits,
    });
    set(internalCreditsExhaustedDraft$, EMPTY_DRAFT);
    if (result.rewardCredits > 0) {
      set(reloadBillingStatus$);
    }
  },
);

// ---------------------------------------------------------------------------
// Abandoned checkout
// ---------------------------------------------------------------------------

/** The server discovers the current member's unpaid Checkout. */
export const abandonedCheckoutSurvey$ = computed(async (get) => {
  const status = await get(billingSurveyStatus$);
  return status?.abandonedCheckout ?? null;
});

/** Persist a per-Checkout dismissal so another browser does not ask it again. */
export const dismissCheckoutAbandonedSurvey$ = command(
  async ({ get, set }, checkoutSessionId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(billingSurveyContract);
    await accept(
      client.dismiss({ body: { checkoutSessionId }, fetchOptions: { signal } }),
      [200],
    );
    signal.throwIfAborted();
    set(statusReload$, (value) => {
      return value + 1;
    });
    await get(billingSurveyStatus$);
    signal.throwIfAborted();
    set(internalCheckoutAbandonedDraft$, EMPTY_DRAFT);
  },
);

export const submitCheckoutAbandonedSurvey$ = command(
  async (
    { get, set },
    checkoutKind: BillingSurveyCheckoutKind,
    checkoutSessionId: string,
    signal: AbortSignal,
  ) => {
    const draft = get(internalCheckoutAbandonedDraft$);
    if (!draft.answer) {
      return;
    }
    await set(
      submitSurvey$,
      {
        survey: "checkout_abandoned",
        answer: draft.answer,
        checkoutKind,
        checkoutSessionId,
        ...draftDetail(draft),
      },
      signal,
    );
    set(internalCheckoutAbandonedDraft$, EMPTY_DRAFT);
    toast.success(
      i18n.t(($) => {
        return $.billing.survey.thanks;
      }),
    );
  },
);
