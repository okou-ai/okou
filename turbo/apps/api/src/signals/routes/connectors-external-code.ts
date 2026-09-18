import { connectorExternalCodeSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  completeConnectorExternalCodeSession$,
  startConnectorExternalCodeSession$,
} from "../services/connector-external-code.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startConnectorExternalCodeSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(connectorExternalCodeSessionContract.create),
    );
    const body = await get(
      bodyResultOf(connectorExternalCodeSessionContract.create),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      startConnectorExternalCodeSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: body.data.agentId,
        authorizeAgent: body.data.authorizeAgent,
        connectorSlug: params.connectorSlug,
        authMethod: body.data.authMethod,
        account: body.data.account,
      },
      signal,
    );
  },
);

const completeConnectorExternalCodeSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(connectorExternalCodeSessionContract.complete),
    );
    const body = await get(
      bodyResultOf(connectorExternalCodeSessionContract.complete),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      completeConnectorExternalCodeSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorSlug: params.connectorSlug,
        sessionId: params.sessionId,
        sessionToken: body.data.sessionToken,
        code: body.data.code,
      },
      signal,
    );
  },
);

export const connectorsExternalCodeRoutes: readonly RouteEntry[] = [
  {
    route: connectorExternalCodeSessionContract.create,
    handler: authRoute(
      connectorWriteAuth,
      startConnectorExternalCodeSessionInner$,
    ),
  },
  {
    route: connectorExternalCodeSessionContract.complete,
    handler: authRoute(
      connectorWriteAuth,
      completeConnectorExternalCodeSessionInner$,
    ),
  },
];
