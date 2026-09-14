import { command } from "ccstate";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { isNotFoundResponse, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  activatePersonalModelProviderAccount,
  deletePersonalModelProviderAccount,
  personalModelProviderAccountById,
} from "../services/model-provider-account.service";
import { consumePersonalCodexRateLimitResetCredit$ } from "../services/model-provider-subscription-usage.service";
import type { RouteEntry } from "../route-entry";

const activateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const featureSwitchContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProviderAccounts,
      featureSwitchContext,
    )
  ) {
    return notFound("Resource not found");
  }
  const params = get(
    pathParamsOf(personalModelProviderAccountsByIdContract.activate),
  );
  const result = await activatePersonalModelProviderAccount({
    db: set(writeDb$),
    orgId: auth.orgId,
    userId: auth.userId,
    id: params.id,
  });
  signal.throwIfAborted();
  return isNotFoundResponse(result)
    ? result
    : { status: 200 as const, body: result };
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const featureSwitchContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProviderAccounts,
      featureSwitchContext,
    )
  ) {
    return notFound("Resource not found");
  }
  const params = get(
    pathParamsOf(personalModelProviderAccountsByIdContract.delete),
  );
  const result = await deletePersonalModelProviderAccount(
    {
      featureSwitchContext,
      db: set(writeDb$),
      orgId: auth.orgId,
      userId: auth.userId,
      id: params.id,
    },
    signal,
  );
  signal.throwIfAborted();
  return isNotFoundResponse(result)
    ? result
    : { status: 204 as const, body: undefined };
});

const resetInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const featureSwitchContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.PersonalModelProviderAccounts,
      featureSwitchContext,
    )
  ) {
    return notFound("Resource not found");
  }
  const params = get(
    pathParamsOf(
      personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ),
  );
  const body = await get(
    bodyResultOf(
      personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    ),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const account = await personalModelProviderAccountById({
    db: set(writeDb$),
    orgId: auth.orgId,
    userId: auth.userId,
    id: params.id,
  });
  signal.throwIfAborted();
  if (!account || account.type !== "codex-oauth-token") {
    return notFound("Resource not found");
  }
  const result = await set(
    consumePersonalCodexRateLimitResetCredit$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      idempotencyKey: body.data.idempotencyKey,
      modelProviderAccountId: account.id,
    },
    signal,
  );
  signal.throwIfAborted();
  return isNotFoundResponse(result)
    ? result
    : { status: 200 as const, body: result };
});

const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const meModelProviderAccountRoutes: readonly RouteEntry[] = [
  {
    route: personalModelProviderAccountsByIdContract.activate,
    handler: authRoute(auth, activateInner$),
  },
  {
    route: personalModelProviderAccountsByIdContract.delete,
    handler: authRoute(auth, deleteInner$),
  },
  {
    route: personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
    handler: authRoute(auth, resetInner$),
  },
];
