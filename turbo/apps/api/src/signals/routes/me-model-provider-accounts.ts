import {
  personalModelProviderAccountsByIdContract,
  personalSubscriptionsContract,
} from "@okouai/api-contracts/contracts/personal-model-providers";
import { command, computed } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import { isNotFoundResponse, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  activatePersonalModelProviderAccount$,
  disconnectPersonalModelProviderAccounts$,
  personalModelProviderAccountById,
  personalModelProviderAccountResponseById,
} from "../services/model-provider-account.service";
import {
  consumePersonalCodexRateLimitResetCredit$,
  refreshPersonalModelProviderSubscriptionUsage$,
} from "../services/model-provider-subscription-usage.service";
import {
  failedRunAccountIdentityCondition,
  personalSubscriptionAccountIdentity,
} from "../services/personal-subscription-recovery.service";
import { resetDisconnectedMemberModelSelection } from "../services/member-subscription-models.service";

const accountResponse$ = personalModelProviderAccountResponseById(
  computed((get) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(personalModelProviderAccountsByIdContract.getById),
    );
    return { orgId: auth.orgId, userId: auth.userId, id: params.id };
  }),
);

const subscriptionResponse$ = personalModelProviderAccountResponseById(
  computed((get) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(personalSubscriptionsContract.get));
    return { orgId: auth.orgId, userId: auth.userId, id: params.id };
  }),
);

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
  const [run] = await get(db$)
    .select({ identity: agentRuns.modelProviderAccountIdentity })
    .from(agentRuns)
    .where(
      failedRunAccountIdentityCondition({
        runId: query.runId,
        accountId: account.id,
        providerType: account.type,
        userId: auth.userId,
        orgId: auth.orgId,
      }),
    )
    .limit(1);
  signal.throwIfAborted();
  const expectedIdentity = run?.identity ?? null;
  if (
    !expectedIdentity ||
    personalSubscriptionAccountIdentity(account) !== expectedIdentity
  ) {
    return notFound("Resource not found");
  }
  const provider = await get(accountResponse$);
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

const getSubscriptionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const provider = await get(subscriptionResponse$);
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
      },
      signal,
    );
    const response = refreshed.modelProviders[0];
    if (!response) {
      throw new Error("Subscription usage refresh returned no account");
    }
    return { status: 200 as const, body: response };
  },
);

const activateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(
    pathParamsOf(personalModelProviderAccountsByIdContract.activate),
  );
  const result = await set(
    activatePersonalModelProviderAccount$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      id: params.id,
    },
    signal,
  );
  signal.throwIfAborted();
  return "status" in result ? result : { status: 200 as const, body: result };
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const featureSwitchContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  const params = get(
    pathParamsOf(personalModelProviderAccountsByIdContract.delete),
  );
  const result = await set(
    disconnectPersonalModelProviderAccounts$,
    {
      featureSwitchContext,
      orgId: auth.orgId,
      userId: auth.userId,
      selection: { kind: "account", id: params.id },
    },
    signal,
  );
  signal.throwIfAborted();
  if (result) {
    return result;
  }
  await resetDisconnectedMemberModelSelection(
    set(writeDb$),
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
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
    const [run] = runId
      ? await get(db$)
          .select({ identity: agentRuns.modelProviderAccountIdentity })
          .from(agentRuns)
          .where(
            failedRunAccountIdentityCondition({
              runId: runId,
              accountId: account.id,
              providerType: account.type,
              userId: auth.userId,
              orgId: auth.orgId,
            }),
          )
          .limit(1)
      : [];
    const expectedIdentity = runId ? (run?.identity ?? null) : undefined;
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
    route: personalSubscriptionsContract.get,
    handler: authRoute(
      { ...auth, requiredCapability: "subscription:read" },
      getSubscriptionInner$,
    ),
  },
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
    handler: authRoute(
      { ...auth, requiredCapability: "subscription:switch" },
      activateInner$,
    ),
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
