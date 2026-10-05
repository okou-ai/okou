import { command } from "ccstate";
import type {
  ModelProviderListResponse,
  ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { refreshPersonalModelProviderSubscriptionUsage$ } from "../services/model-provider-subscription-usage.service";
import { listPersonalModelProviderAccounts } from "../services/model-provider-account.service";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";

function isModelFirstPersonalProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function visibleModelFirstProviders(
  result: ModelProviderListResponse,
): ModelProviderListResponse {
  return {
    modelProviders: result.modelProviders.filter((provider) => {
      return isModelFirstPersonalProviderType(provider.type);
    }),
  };
}

const listInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const result = await listPersonalModelProviderAccounts({
    db: set(writeDb$),
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  const visible = visibleModelFirstProviders(result);
  const refreshed = await set(
    refreshPersonalModelProviderSubscriptionUsage$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      result: visible,
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
