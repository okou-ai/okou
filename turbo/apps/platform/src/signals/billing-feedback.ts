import { locale$ } from "./locale.ts";
import { command, computed, state } from "ccstate";
import type { Survey, MultipleSurveyQuestion } from "posthog-js";
import { applySurveyTranslation } from "@posthog/core/surveys";
import { billingFeedbackRewardContract } from "@okouai/api-contracts/client/billing";
import { BILLING_FEEDBACK_SURVEYS } from "@okouai/core/billing-feedback";
import { accept } from "../lib/accept.ts";
import {
  captureBillingFeedbackSurvey,
  watchBillingFeedbackSurvey,
} from "../lib/posthog.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedIdentity$, authenticatedSessionKey$ } from "./auth.ts";
import {
  consumeBillingFeedback$,
  pendingBillingFeedback$,
} from "./billing-feedback-flow.ts";
import {
  billingStatusAsync$,
  handleBillingRedirect$,
} from "./okou-page/billing.ts";
import { userPreferences$ } from "./okou-page/settings/user-preferences.ts";
import { settingsDialogSessionActive$ } from "./okou-page/settings/settings-dialog-session.ts";
import { isOrgAdmin$ } from "./org.ts";
import { searchParams$ } from "./route.ts";
import { onRef, resetSignal } from "./utils.ts";

const billingFeedbackOffer$ = computed(async (get) => {
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
    const offer = await get(billingFeedbackOffer$);
    signal.throwIfAborted();
    if (!offer) {
      return;
    }
    const preferences = await get(userPreferences$);
    signal.throwIfAborted();
    if (!set(consumeBillingFeedback$, request.id)) {
      return;
    }
    const locale = preferences.supportedLocales.includes(preferences.locale)
      ? preferences.locale
      : get(locale$);
    const sessionKey = get(authenticatedSessionKey$);
    let opened = false;
    watchBillingFeedbackSurvey(
      BILLING_FEEDBACK_SURVEYS[request.kind],
      (available) => {
        if (
          !available ||
          opened ||
          sessionKey !== get(authenticatedSessionKey$)
        ) {
          return;
        }
        const { survey, matchedKey } = applySurveyTranslation(
          available,
          locale === "zh-Hans"
            ? "zh-cn"
            : locale === "zh-Hant"
              ? "zh-tw"
              : locale,
        );
        const question = survey.questions[0];
        if (question?.type !== "single_choice" || !question.id) {
          return;
        }
        opened = true;
        set(feedbackSession$, {
          sessionKey,
          survey,
          question,
          language: matchedKey,
          submissionId: crypto.randomUUID(),
          properties: {
            org_id: identity.orgId,
            billing_feedback_kind: request.kind,
            billing_attempt_id: request.id,
            billing_feedback_reward_token: offer.token,
          },
          choice: null,
          otherText: "",
          shown: false,
          submitted: false,
        });
      },
      signal,
    );
    signal.addEventListener(
      "abort",
      () => {
        if (
          get(feedbackSession$)?.properties.billing_attempt_id === request.id
        ) {
          set(feedbackSession$, null);
        }
      },
      { once: true },
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

interface FeedbackSession {
  readonly sessionKey: string | null;
  readonly survey: Survey;
  readonly question: MultipleSurveyQuestion;
  readonly language: string | null;
  readonly submissionId: string;
  readonly properties: Record<string, unknown>;
  readonly choice: number | null;
  readonly otherText: string;
  readonly shown: boolean;
  readonly submitted: boolean;
}

const feedbackSession$ = state<FeedbackSession | null>(null);

export const billingFeedbackSession$ = computed((get) => {
  const session = get(feedbackSession$);
  return session?.sessionKey === get(authenticatedSessionKey$) ? session : null;
});

export const billingFeedbackOtherSelected$ = computed((get) => {
  const session = get(billingFeedbackSession$);
  return Boolean(
    session?.question.hasOpenChoice &&
    session.choice === session.question.choices.length - 1,
  );
});

export const billingFeedbackCanSubmit$ = computed((get) => {
  const session = get(billingFeedbackSession$);
  return Boolean(
    session &&
    !session.submitted &&
    session.choice !== null &&
    (!get(billingFeedbackOtherSelected$) || session.otherText.trim()),
  );
});

export const markBillingFeedbackShown$ = onRef(
  command(({ get, set }) => {
    const session = get(billingFeedbackSession$);
    if (!session || session.shown) {
      return;
    }
    set(feedbackSession$, { ...session, shown: true });
    captureBillingFeedbackSurvey("survey shown", session);
  }),
);

export const selectBillingFeedbackChoice$ = command(
  ({ get, set }, choice: number) => {
    const session = get(billingFeedbackSession$);
    if (
      session &&
      !session.submitted &&
      session.question.choices[choice] !== undefined
    ) {
      set(feedbackSession$, { ...session, choice, otherText: "" });
    }
  },
);

export const setBillingFeedbackOtherText$ = command(
  ({ get, set }, otherText: string) => {
    const session = get(billingFeedbackSession$);
    if (session && !session.submitted) {
      set(feedbackSession$, { ...session, otherText });
    }
  },
);

export const submitBillingFeedback$ = command(({ get, set }) => {
  const session = get(billingFeedbackSession$);
  if (!session || session.choice === null || !get(billingFeedbackCanSubmit$)) {
    return;
  }
  const response = get(billingFeedbackOtherSelected$)
    ? session.otherText.trim()
    : session.question.choices[session.choice];
  // Close the submission path synchronously, including rapid double clicks.
  set(feedbackSession$, { ...session, submitted: true });
  captureBillingFeedbackSurvey("survey sent", session, response);
});

export const closeBillingFeedback$ = command(({ get, set }) => {
  const session = get(billingFeedbackSession$);
  set(feedbackSession$, null);
  if (session?.shown && !session.submitted) {
    captureBillingFeedbackSurvey("survey dismissed", session);
  }
});
