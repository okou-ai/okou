import { command } from "ccstate";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { refreshPersonalModelProviderSubscriptionUsage$ } from "../services/model-provider-subscription-usage.service";
import { listPersonalModelProviderAccounts } from "../services/model-provider-account.service";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";

const listInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await listPersonalModelProviderAccounts({
    db: set(writeDb$),
    orgId: auth.orgId,
    userId: auth.userId,
  });
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
  return {
    status: 200 as const,
    body: refreshed,
  };
});

export const meModelProvidersListRoutes: readonly RouteEntry[] = [
  {
    route: personalModelProvidersMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listInner$,
    ),
  },
];
