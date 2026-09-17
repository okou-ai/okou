import {
  agentSshAccessContract,
  sshHostsContract,
} from "@okouai/api-contracts/contracts/ssh-access";
import { command } from "ccstate";

import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { sshErrorResponse } from "../../lib/ssh-error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  getAgentSshAccess,
  listRunSshHosts,
  updateAgentSshAccess,
} from "../services/ssh-access.service";

const unavailable = Object.freeze(
  sshErrorResponse(
    404,
    SSH_ERROR_CODES.UNAVAILABLE,
    "SSH access is not available",
  ),
);
const agentUnavailable = Object.freeze(
  sshErrorResponse(
    404,
    SSH_ERROR_CODES.AGENT_UNAVAILABLE,
    "Agent is not available",
  ),
);
const ownerAuth = {
  accept: ["session"],
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const getAccess$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(agentSshAccessContract.get));
  const result = await getAgentSshAccess(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    agentId: params.agentId,
  });
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : agentUnavailable;
});

const updateAccess$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(agentSshAccessContract.update));
  const body = await get(bodyResultOf(agentSshAccessContract.update));
  signal.throwIfAborted();
  if (!body.ok) {
    return sshErrorResponse(
      400,
      SSH_ERROR_CODES.INVALID_INPUT,
      "Invalid SSH access",
    );
  }
  const result = await updateAgentSshAccess(
    set(writeDb$),
    { orgId: auth.orgId, userId: auth.userId, agentId: params.agentId },
    body.data.enabled,
    signal,
  );
  return result ? { status: 200 as const, body: result } : agentUnavailable;
});

const listHosts$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("SSH inventory requires Agent authentication");
  }
  const result = await listRunSshHosts(get(db$), auth, signal);
  signal.throwIfAborted();
  return result ? { status: 200 as const, body: result } : unavailable;
});

export const sshAccessRoutes: readonly RouteEntry[] = [
  {
    route: agentSshAccessContract.get,
    handler: authRoute(ownerAuth, getAccess$),
  },
  {
    route: agentSshAccessContract.update,
    handler: authRoute(ownerAuth, updateAccess$),
  },
  {
    route: sshHostsContract.list,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "ssh:read",
      },
      listHosts$,
    ),
  },
];
