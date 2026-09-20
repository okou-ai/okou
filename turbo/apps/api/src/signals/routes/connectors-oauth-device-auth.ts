import { builtinConnectorOauthDeviceAuthSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  pollBuiltinConnectorOauthDeviceAuthSession$,
  startBuiltinConnectorOauthDeviceAuthSession$,
} from "../services/builtin-connector-oauth-device-auth.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startBuiltinConnectorOauthDeviceAuthSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(builtinConnectorOauthDeviceAuthSessionContract.create),
    );
    const body = await get(
      bodyResultOf(builtinConnectorOauthDeviceAuthSessionContract.create),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      startBuiltinConnectorOauthDeviceAuthSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        agentId: body.data.agentId,
        authorizeAgent: body.data.authorizeAgent,
        connectorSlug: params.connectorSlug,
        authMethod: body.data.authMethod,
        options: body.data.options,
        account: body.data.account,
      },
      signal,
    );
  },
);

const pollBuiltinConnectorOauthDeviceAuthSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(builtinConnectorOauthDeviceAuthSessionContract.poll),
    );
    const body = await get(
      bodyResultOf(builtinConnectorOauthDeviceAuthSessionContract.poll),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      pollBuiltinConnectorOauthDeviceAuthSession$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        connectorSlug: params.connectorSlug,
        sessionId: params.sessionId,
        sessionToken: body.data.sessionToken,
      },
      signal,
    );
  },
);

export const builtinConnectorsOauthDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: builtinConnectorOauthDeviceAuthSessionContract.create,
    handler: authRoute(
      connectorWriteAuth,
      startBuiltinConnectorOauthDeviceAuthSessionInner$,
    ),
  },
  {
    route: builtinConnectorOauthDeviceAuthSessionContract.poll,
    handler: authRoute(
      connectorWriteAuth,
      pollBuiltinConnectorOauthDeviceAuthSessionInner$,
    ),
  },
];
