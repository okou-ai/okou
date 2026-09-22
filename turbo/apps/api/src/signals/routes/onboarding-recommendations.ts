import { onboardingRecommendationContract } from "@okouai/api-contracts/contracts/onboarding";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  executeOnboardingRecommendationWork$,
  onboardingRecommendationStatus,
  startOnboardingRecommendation$,
} from "../services/onboarding-recommendation.service";
import { settleIncludingAbort } from "../utils";

const L = logger("route:onboarding-recommendations");

function recommendationDisabled() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "Onboarding recommendations are not enabled",
        code: "FORBIDDEN",
      },
    },
  };
}

const onboardingRecommendationEnabled$ = command(
  async (
    { get },
    identity: { readonly orgId: string; readonly userId: string },
  ): Promise<boolean> => {
    const overrides = await get(
      userFeatureSwitchOverrides(identity.orgId, identity.userId),
    );
    return isFeatureEnabled(FeatureSwitchKey.OnboardingSourcesFirst, {
      orgId: identity.orgId,
      userId: identity.userId,
      overrides,
    });
  },
);

async function observeImmediateWork(
  jobId: string,
  work: Promise<unknown>,
): Promise<void> {
  const result = await settleIncludingAbort(work);
  if (!result.ok) {
    L.debug("Immediate onboarding recommendation work yielded to cron", {
      jobId,
    });
  }
}

const startBody$ = bodyResultOf(onboardingRecommendationContract.start);
const getParams$ = pathParamsOf(onboardingRecommendationContract.get);

const start$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const body = await get(startBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const auth = get(organizationAuthContext$);
  const enabled = await set(onboardingRecommendationEnabled$, {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  if (!enabled) {
    return recommendationDisabled();
  }
  const result = await set(
    startOnboardingRecommendation$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      industry: body.data.industry,
      locale: body.data.locale,
    },
    signal,
  );
  signal.throwIfAborted();
  waitUntil(
    observeImmediateWork(
      result.jobId,
      set(
        executeOnboardingRecommendationWork$,
        { jobId: result.jobId, maxJobs: 1 },
        AbortSignal.timeout(48_000),
      ),
    ),
  );
  return { status: 202 as const, body: result };
});

const get$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const auth = get(organizationAuthContext$);
  const enabled = await set(onboardingRecommendationEnabled$, {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  if (!enabled) {
    return recommendationDisabled();
  }
  const status = await get(
    onboardingRecommendationStatus({
      jobId: get(getParams$).jobId,
      orgId: auth.orgId,
      userId: auth.userId,
    }),
  );
  signal.throwIfAborted();
  return status === null
    ? notFound("Onboarding recommendation not found")
    : { status: 200 as const, body: status };
});

const onboardingRecommendationAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const onboardingRecommendationRoutes: readonly RouteEntry[] = [
  {
    route: onboardingRecommendationContract.start,
    handler: authRoute(onboardingRecommendationAuth, start$),
  },
  {
    route: onboardingRecommendationContract.get,
    handler: authRoute(onboardingRecommendationAuth, get$),
  },
];
