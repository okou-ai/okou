import { modelCatalog$ } from "../services/model-catalog.service";
import { personalModelProvidersByTypeContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { deleteUserModelProvider$ } from "../services/model-provider.service";
import { resetStaleAutoMemberSelection } from "../services/member-subscription-models.service";

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
  await resetStaleAutoMemberSelection(
    await get(modelCatalog$),
    set(writeDb$),
    auth.orgId,
    auth.userId,
  );
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
