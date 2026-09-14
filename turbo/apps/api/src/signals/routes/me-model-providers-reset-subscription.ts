import { command } from "ccstate";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { isNotFoundResponse, notFound } from "../../lib/error";
import { consumePersonalCodexRateLimitResetCredit$ } from "../services/model-provider-subscription-usage.service";
import type { RouteEntry } from "../route-entry";
import { writeDb$ } from "../external/db";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import { listPersonalModelProviderAccounts } from "../services/model-provider-account.service";

const resetSubscriptionUsageInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(personalModelProvidersByTypeContract.resetSubscriptionUsage),
    );
    signal.throwIfAborted();

    if (params.type !== "codex-oauth-token") {
      return notFound(`Provider "${params.type}" not found`);
    }

    const bodyResult = await get(
      bodyResultOf(personalModelProvidersByTypeContract.resetSubscriptionUsage),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const featureSwitchContext = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    const activeAccount = (
      await listPersonalModelProviderAccounts({
        db: set(writeDb$),
        orgId: auth.orgId,
        userId: auth.userId,
        featureSwitchContext,
      })
    ).modelProviders.find((provider) => {
      return provider.type === params.type && provider.isActive;
    });
    if (!activeAccount) {
      return notFound(`Provider "${params.type}" not found`);
    }

    const result = await set(
      consumePersonalCodexRateLimitResetCredit$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        idempotencyKey: bodyResult.data.idempotencyKey,
        modelProviderAccountId: activeAccount.id,
      },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    return { status: 200 as const, body: result };
  },
);

export const meModelProvidersResetSubscriptionRoutes: readonly RouteEntry[] = [
  {
    route: personalModelProvidersByTypeContract.resetSubscriptionUsage,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      resetSubscriptionUsageInner$,
    ),
  },
];
