import { connectorOauthDeviceAuthSessionContract } from "@okouai/api-contracts/contracts/connectors";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  pollConnectorOauthDeviceAuthSession$,
  startConnectorOauthDeviceAuthSession$,
} from "../services/connector-oauth-device-auth.service";

const connectorWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const startConnectorOauthDeviceAuthSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(connectorOauthDeviceAuthSessionContract.create),
    );
    const body = await get(
      bodyResultOf(connectorOauthDeviceAuthSessionContract.create),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      startConnectorOauthDeviceAuthSession$,
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

const pollConnectorOauthDeviceAuthSessionInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(
      pathParamsOf(connectorOauthDeviceAuthSessionContract.poll),
    );
    const body = await get(
      bodyResultOf(connectorOauthDeviceAuthSessionContract.poll),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    return await set(
      pollConnectorOauthDeviceAuthSession$,
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

export const connectorsOauthDeviceAuthRoutes: readonly RouteEntry[] = [
  {
    route: connectorOauthDeviceAuthSessionContract.create,
    handler: authRoute(
      connectorWriteAuth,
      startConnectorOauthDeviceAuthSessionInner$,
    ),
  },
  {
    route: connectorOauthDeviceAuthSessionContract.poll,
    handler: authRoute(
      connectorWriteAuth,
      pollConnectorOauthDeviceAuthSessionInner$,
    ),
  },
];
