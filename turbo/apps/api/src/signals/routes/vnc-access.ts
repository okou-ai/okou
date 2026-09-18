import {
  agentVncAccessContract,
  vncHostsContract,
} from "@okouai/api-contracts/contracts/vnc-access";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { vncErrorResponse } from "../../lib/vnc-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  getAgentVncAccess,
  listRunVncHosts,
  updateAgentVncAccess,
} from "../services/vnc-access.service";
import { hasCurrentVncMembership } from "../services/vnc-owner-lifecycle.service";

const unavailable = Object.freeze(
  vncErrorResponse(
    404,
    VNC_ERROR_CODES.UNAVAILABLE,
    "VNC access is not available",
  ),
);
const ownerAuth = {
  accept: ["session"],
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const admission$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = get(organizationAuthContext$);
  const db = set(writeDb$);
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.VncAccess, featureContext)) {
    return null;
  }
  if (!(await hasCurrentVncMembership(get(clerk$), auth, signal))) {
    return null;
  }
  return { db, owner: { orgId: auth.orgId, userId: auth.userId } };
});

const getAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const admitted = await set(admission$, signal);
  if (!admitted) {
    return unavailable;
  }
  const params = get(pathParamsOf(agentVncAccessContract.get));
  const result = await getAgentVncAccess(admitted.db, {
    ...admitted.owner,
    agentId: params.agentId,
  });
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : unavailable;
});

const updateAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const admitted = await set(admission$, signal);
  if (!admitted) {
    return unavailable;
  }
  const params = get(pathParamsOf(agentVncAccessContract.update));
  const body = await get(bodyResultOf(agentVncAccessContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return vncErrorResponse(
      400,
      VNC_ERROR_CODES.INVALID_INPUT,
      "Invalid VNC access",
    );
  }
  const result = await updateAgentVncAccess(
    admitted.db,
    { ...admitted.owner, agentId: params.agentId },
    body.data.enabled,
    signal,
  );
  return result ? { status: 200 as const, body: result } : unavailable;
});

const listHosts$ = command(async ({ get, set }, signal: AbortSignal) => {
  const admitted = await set(admission$, signal);
  if (!admitted) {
    return unavailable;
  }
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("VNC inventory requires Agent authentication");
  }
  const result = await listRunVncHosts(admitted.db, auth, signal);
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : unavailable;
});

export const vncAccessRoutes: readonly RouteEntry[] = [
  {
    route: agentVncAccessContract.get,
    handler: authRoute(ownerAuth, getAccess$),
  },
  {
    route: agentVncAccessContract.update,
    handler: authRoute(ownerAuth, updateAccess$),
  },
  {
    route: vncHostsContract.list,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "vnc:read",
      },
      listHosts$,
    ),
  },
];
