import { command } from "ccstate";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { deleteUserModelProvider$ } from "../services/model-provider.service";
import { resetStaleAutoMemberSelection$ } from "../services/subscription-model-catalog.service";
import type { RouteEntry } from "../route-entry";

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);

  const params = get(pathParamsOf(personalModelProvidersByTypeContract.delete));
  signal.throwIfAborted();

  const result = await set(
    deleteUserModelProvider$,
    { orgId: auth.orgId, userId: auth.userId, type: params.type },
    signal,
  );
  signal.throwIfAborted();

  if (result) {
    return result;
  }
  await set(resetStaleAutoMemberSelection$, auth.orgId, auth.userId, signal);
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const meModelProvidersDeleteRoutes: readonly RouteEntry[] = [
  {
    route: personalModelProvidersByTypeContract.delete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      deleteInner$,
    ),
  },
];
