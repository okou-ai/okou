import { command } from "ccstate";
import { customConnectorByIdContract } from "@okouai/api-contracts/contracts/custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { deleteCustomConnector$ } from "../services/custom-connector.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can delete custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  const params = get(pathParamsOf(customConnectorByIdContract.delete));
  signal.throwIfAborted();

  const result = await set(
    deleteCustomConnector$,
    { orgId: auth.orgId, id: params.id },
    signal,
  );
  signal.throwIfAborted();

  if (result) {
    return result;
  }
  return { status: 204 as const, body: undefined };
});

export const customConnectorsDeleteRoutes: readonly RouteEntry[] = [
  {
    route: customConnectorByIdContract.delete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      deleteInner$,
    ),
  },
];
