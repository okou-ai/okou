import { command } from "ccstate";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { thirdPartySubscriptionsMainContract } from "@okouai/api-contracts/contracts/third-party-subscriptions";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { refreshPersonalModelProviderSubscriptionUsage$ } from "../services/model-provider-subscription-usage.service";
import { personalModelProviderAccounts } from "../services/model-provider-account.service";
import type { RouteEntry } from "../route-entry";

const accounts$ = personalModelProviderAccounts(organizationAuthContext$);

const listAccounts$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await get(accounts$);
  signal.throwIfAborted();
  const refreshed = await set(
    refreshPersonalModelProviderSubscriptionUsage$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      result,
    },
    signal,
  );
  signal.throwIfAborted();
  return refreshed;
});

const listInner$ = command(async ({ set }, signal: AbortSignal) => {
  return {
    status: 200 as const,
    body: await set(listAccounts$, signal),
  };
});

const listSubscriptionsInner$ = command(
  async ({ set }, signal: AbortSignal) => {
    const result = await set(listAccounts$, signal);
    return {
      status: 200 as const,
      body: { subscriptions: result.modelProviders },
    };
  },
);

const listAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "subscription:read",
} as const;

export const meModelProvidersListRoutes: readonly RouteEntry[] = [
  {
    route: personalModelProvidersMainContract.list,
    handler: authRoute(listAuthOptions, listInner$),
  },
];

export const meThirdPartySubscriptionsListRoutes: readonly RouteEntry[] = [
  {
    route: thirdPartySubscriptionsMainContract.list,
    handler: authRoute(listAuthOptions, listSubscriptionsInner$),
  },
];
