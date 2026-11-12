import { billingSurveyContract } from "@okouai/api-contracts/contracts/billing";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  answeredBillingSurveys$,
  creditsExhaustedSurveyReward$,
  recordBillingSurvey$,
} from "../services/billing-survey.service";
import {
  abandonedBillingCheckout$,
  ownedUnpaidBillingCheckout$,
  dismissBillingCheckoutSurvey$,
} from "../services/billing-survey-checkout.service";
import { publishBillingChangedForOrg$ } from "../services/billing-realtime.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

const surveyBody$ = bodyResultOf(billingSurveyContract.submit);

const billingSurveyEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.BillingSurvey, {
    orgId: auth.orgId,
    userId: auth.userId,
    overrides,
  });
});

function surveyUnavailable() {
  return notFound("Billing survey is not available");
}

const surveyStatusAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const enabled = await set(billingSurveyEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      return surveyUnavailable();
    }
    const query = get(queryOf(billingSurveyContract.status));
    const answered = await set(
      answeredBillingSurveys$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    const abandonedCheckout = answered.includes("checkout_abandoned")
      ? null
      : await set(
          abandonedBillingCheckout$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            returnedFromCheckout: query.checkoutReturn === "canceled",
          },
          signal,
        );
    const reward = await set(
      creditsExhaustedSurveyReward$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        canManageBilling: auth.orgRole === "admin",
      },
      signal,
    );
    return {
      status: 200 as const,
      body: {
        answered: [...answered],
        creditsExhaustedReward: reward,
        abandonedCheckout,
      },
    };
  },
);

const surveySubmitAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const enabled = await set(billingSurveyEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      return surveyUnavailable();
    }
    const bodyResult = await get(surveyBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    let request = bodyResult.data;
    if (request.survey === "checkout_abandoned") {
      const kind = await set(
        ownedUnpaidBillingCheckout$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          sessionId: request.checkoutSessionId,
        },
        signal,
      );
      if (!kind) {
        return {
          status: 200 as const,
          body: { recorded: false, rewardCredits: 0 },
        };
      }
      request = { ...request, checkoutKind: kind };
    }
    const result = await set(
      recordBillingSurvey$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        request,
        canManageBilling: auth.orgRole === "admin",
      },
      signal,
    );
    if (result.rewardCredits > 0) {
      await set(publishBillingChangedForOrg$, auth.orgId);
      signal.throwIfAborted();
    }
    return { status: 200 as const, body: result };
  },
);

const surveyStatus$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      surveyStatusAuthed$,
    ),
    signal,
  );
});

const surveySubmit$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      surveySubmitAuthed$,
    ),
    signal,
  );
});

const surveyDismissBody$ = bodyResultOf(billingSurveyContract.dismiss);
const surveyDismissAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const enabled = await set(billingSurveyEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      return surveyUnavailable();
    }
    const body = await get(surveyDismissBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    await set(
      dismissBillingCheckoutSurvey$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        sessionId: body.data.checkoutSessionId,
      },
      signal,
    );
    return { status: 200 as const, body: { dismissed: true } };
  },
);
const surveyDismiss$ = command(async ({ set }, signal: AbortSignal) => {
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      surveyDismissAuthed$,
    ),
    signal,
  );
});

export const billingSurveyRoutes: readonly RouteEntry[] = [
  { route: billingSurveyContract.status, handler: surveyStatus$ },
  { route: billingSurveyContract.submit, handler: surveySubmit$ },
  { route: billingSurveyContract.dismiss, handler: surveyDismiss$ },
];
