import { command } from "ccstate";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { listAvailableRunModels$ } from "../services/run-models.service";
import type { RouteEntry } from "../route-entry";

const listRunModels$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await set(
    listAvailableRunModels$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  return { status: 200 as const, body };
});

export const runModelsRoutes: readonly RouteEntry[] = [
  {
    route: runModelsMainContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        acceptAnySandboxCapability: true,
        oauthScope: "okou:chat:read",
      },
      listRunModels$,
    ),
  },
];
