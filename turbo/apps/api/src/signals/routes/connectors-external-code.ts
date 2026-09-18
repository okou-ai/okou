import { builtinConnectorExternalCodeSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  completeBuiltinConnectorExternalCodeSession$,
  startBuiltinConnectorExternalCodeSession$,
} from "../services/builtin-connector-external-code.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startBuiltinConnectorExternalCodeSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(builtinConnectorExternalCodeSessionContract.create),
    );
    const body = await get(
      bodyResultOf(builtinConnectorExternalCodeSessionContract.create),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      startBuiltinConnectorExternalCodeSession$,
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

const completeBuiltinConnectorExternalCodeSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(builtinConnectorExternalCodeSessionContract.complete),
    );
    const body = await get(
      bodyResultOf(builtinConnectorExternalCodeSessionContract.complete),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      completeBuiltinConnectorExternalCodeSession$,
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

export const builtinConnectorsExternalCodeRoutes: readonly RouteEntry[] = [
  {
    route: builtinConnectorExternalCodeSessionContract.create,
    handler: authRoute(
      connectorWriteAuth,
      startBuiltinConnectorExternalCodeSessionInner$,
    ),
  },
  {
    route: builtinConnectorExternalCodeSessionContract.complete,
    handler: authRoute(
      connectorWriteAuth,
      completeBuiltinConnectorExternalCodeSessionInner$,
    ),
  },
];
