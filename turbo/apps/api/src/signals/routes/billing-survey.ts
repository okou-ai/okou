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
  checkoutUnpaid$,
  creditsExhaustedSurveyReward$,
  recordBillingSurvey$,
} from "../services/billing-survey.service";
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
    const checkoutUnpaid = query.checkoutSessionId
      ? await set(
          checkoutUnpaid$,
          {
            orgId: auth.orgId,
            sessionId: query.checkoutSessionId,
          },
          signal,
        )
      : false;
    const answered = await set(
      answeredBillingSurveys$,
      { orgId: auth.orgId, userId: auth.userId },
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
        checkoutUnpaid,
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
    if (
      bodyResult.data.survey === "checkout_abandoned" &&
      !(await set(
        checkoutUnpaid$,
        {
          orgId: auth.orgId,
          sessionId: bodyResult.data.checkoutSessionId,
        },
        signal,
      ))
    ) {
      return {
        status: 200 as const,
        body: { recorded: false, rewardCredits: 0 },
      };
    }
    const result = await set(
      recordBillingSurvey$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        request: bodyResult.data,
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

export const billingSurveyRoutes: readonly RouteEntry[] = [
  { route: billingSurveyContract.status, handler: surveyStatus$ },
  { route: billingSurveyContract.submit, handler: surveySubmit$ },
];
