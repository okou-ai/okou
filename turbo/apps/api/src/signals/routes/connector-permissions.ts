import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { badRequestMessage, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  applyConnectorPermissions$,
  connectorPermissions,
} from "../services/connector-permissions.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";

const ownerAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;
const unavailable = notFound(
  "Connector permission configuration is not available",
);
const missing = notFound("Connector account not found");
const owner$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return { orgId: auth.orgId, userId: auth.userId };
});
const featureAvailable$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const owner = get(owner$);
  const context = await set(
    loadUserFeatureSwitchContext$,
    owner.orgId,
    owner.userId,
    signal,
  );
  return isFeatureEnabled(FeatureSwitchKey.ConnectorChatAccountAccess, context);
});
const scope$ = computed((get) => {
  return {
    ...get(owner$),
    target: get(queryOf(connectorPermissionsContract.get)),
  };
});
const permissions$ = connectorPermissions(scope$);
const getHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const body = await get(permissions$);
  signal.throwIfAborted();
  return body ? { status: 200 as const, body } : missing;
});
const applyScope$ = computed(async (get) => {
  const body = await get(bodyResultOf(connectorPermissionsContract.apply));
  return body.ok ? { ...get(owner$), target: body.data.target } : null;
});
const appliedPermissions$ = connectorPermissions(applyScope$);
const applyHandler$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(featureAvailable$, signal))) {
    return unavailable;
  }
  const body = await get(bodyResultOf(connectorPermissionsContract.apply));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    applyConnectorPermissions$,
    { ...get(owner$), target: body.data.target },
    body.data,
    signal,
  );
  if (result === "not_found") {
    return missing;
  }
  if (result !== "updated") {
    return badRequestMessage(result);
  }
  const response = await get(appliedPermissions$);
  signal.throwIfAborted();
  return response ? { status: 200 as const, body: response } : missing;
});

export const connectorPermissionsRoutes: readonly RouteEntry[] = [
  {
    route: connectorPermissionsContract.get,
    handler: authRoute(ownerAuth, getHandler$),
  },
  {
    route: connectorPermissionsContract.apply,
    handler: authRoute(ownerAuth, applyHandler$),
  },
];
