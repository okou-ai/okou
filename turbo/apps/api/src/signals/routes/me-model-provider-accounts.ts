import { command } from "ccstate";
import { personalModelProviderAccountsByIdContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { isNotFoundResponse, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  activatePersonalModelProviderAccount,
  deletePersonalModelProviderAccount,
  personalModelProviderAccountById,
  personalModelProviderAccountResponseById,
} from "../services/model-provider-account.service";
import {
  consumePersonalCodexRateLimitResetCredit$,
  refreshPersonalModelProviderSubscriptionUsage$,
} from "../services/model-provider-subscription-usage.service";
import {
  failedRunAccountIdentity,
  personalSubscriptionAccountIdentity,
} from "../services/personal-subscription-recovery.service";
import type { RouteEntry } from "../route-entry";

const getInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(personalModelProviderAccountsByIdContract.getById),
  );
  const query = get(queryOf(personalModelProviderAccountsByIdContract.getById));
  const args = {
    db: set(writeDb$),
    orgId: auth.orgId,
    userId: auth.userId,
    id: params.id,
  };
  const account = await personalModelProviderAccountById(args);
  signal.throwIfAborted();
  if (!account) {
    return notFound("Resource not found");
  }
  const expectedIdentity = await failedRunAccountIdentity({
    ...args,
    runId: query.runId,
    accountId: account.id,
    providerType: account.type,
  });
  signal.throwIfAborted();
  if (
    !expectedIdentity ||
    personalSubscriptionAccountIdentity(account) !== expectedIdentity
  ) {
    return notFound("Resource not found");
  }
  const provider = await personalModelProviderAccountResponseById(args);
  signal.throwIfAborted();
  if (!provider) {
    return notFound("Resource not found");
  }
  const refreshed = await set(
    refreshPersonalModelProviderSubscriptionUsage$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      result: { modelProviders: [provider] },
      expectedAccountIdentity: expectedIdentity,
    },
    signal,
  );
  signal.throwIfAborted();
  const current = await personalModelProviderAccountById(args);
  signal.throwIfAborted();
  if (
    !current ||
    personalSubscriptionAccountIdentity(current) !== expectedIdentity
  ) {
    return notFound("Resource not found");
  }
  const response = refreshed.modelProviders[0];
  if (!response) {
    throw new Error("Exact account usage refresh returned no account");
  }
  return { status: 200 as const, body: response };
});

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
  const result = await activatePersonalModelProviderAccount(
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

function resetAccountSubscriptionUsage(
  route:
    | typeof personalModelProviderAccountsByIdContract.resetSubscriptionUsage
    | typeof personalModelProviderAccountsByIdContract.resetFailedRunSubscriptionUsage,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(route));
    const runId = "runId" in params ? params.runId : undefined;
    const featureSwitchContext = await get(
      userFeatureSwitchContext(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.PersonalModelProviderAccounts,
        featureSwitchContext,
      ) &&
      !runId
    ) {
      return notFound("Resource not found");
    }
    const body = await get(bodyResultOf(route));
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
    const expectedIdentity = runId
      ? await failedRunAccountIdentity({
          db: set(writeDb$),
          orgId: auth.orgId,
          userId: auth.userId,
          runId: runId,
          accountId: account.id,
          providerType: account.type,
        })
      : undefined;
    if (
      runId &&
      (!expectedIdentity ||
        personalSubscriptionAccountIdentity(account) !== expectedIdentity)
    ) {
      return notFound("Resource not found");
    }
    const result = await set(
      consumePersonalCodexRateLimitResetCredit$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        idempotencyKey: body.data.idempotencyKey,
        modelProviderAccountId: account.id,
        ...(expectedIdentity
          ? { expectedAccountIdentity: expectedIdentity }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    return isNotFoundResponse(result)
      ? result
      : { status: 200 as const, body: result };
  });
}

const resetInner$ = resetAccountSubscriptionUsage(
  personalModelProviderAccountsByIdContract.resetSubscriptionUsage,
);
const resetFailedRunInner$ = resetAccountSubscriptionUsage(
  personalModelProviderAccountsByIdContract.resetFailedRunSubscriptionUsage,
);

const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const meModelProviderAccountRoutes: readonly RouteEntry[] = [
  {
    route:
      personalModelProviderAccountsByIdContract.resetFailedRunSubscriptionUsage,
    handler: authRoute(auth, resetFailedRunInner$),
  },
  {
    route: personalModelProviderAccountsByIdContract.getById,
    handler: authRoute(auth, getInner$),
  },
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
