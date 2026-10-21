import { command } from "ccstate";
import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  createCustomConnector$,
  serialiseCustomConnector,
} from "../services/custom-connector.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can create custom connectors",
      code: "FORBIDDEN",
    }),
  }),
});

const createInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const bodyResult = await get(bodyResultOf(customConnectorsContract.create));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    createCustomConnector$,
    { orgId: auth.orgId, userId: auth.userId, input: bodyResult.data },
    signal,
  );

  if ("status" in result) {
    return result;
  }

  return {
    status: 201 as const,
    body: serialiseCustomConnector({
      row: result,
    }),
  };
});

export const customConnectorsCreateRoutes: readonly RouteEntry[] = [
  {
    route: customConnectorsContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "connector:write",
      },
      createInner$,
    ),
  },
];
