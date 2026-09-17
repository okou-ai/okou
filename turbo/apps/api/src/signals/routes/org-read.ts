import { command } from "ccstate";
import {
  orgContract,
  orgLeaveContract,
} from "@okouai/api-contracts/contracts/org-routes";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import {
  badRequestMessage,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import type { RouteEntry } from "../route-entry";
import { clerkRateLimit } from "../external/clerk";
import {
  createdOrganizationsCount$,
  leaveOrg$,
  orgDetail$,
  orgMembersList$,
  updateOrg$,
} from "../services/org-data.service";
import { settle } from "../utils";

const getOrgInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return notFound("Organization not found");
  }
  const org = await set(
    orgDetail$,
    { orgId: auth.orgId, userId: auth.userId, orgRole: auth.orgRole },
    signal,
  );
  signal.throwIfAborted();
  if (!org) {
    return notFound("Organization not found");
  }
  return { status: 200 as const, body: org };
});

const getCreatedOrganizationsCountInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const result = await settle(
      set(createdOrganizationsCount$, auth.userId, signal),
      signal,
    );
    if (result.ok) {
      return {
        status: 200 as const,
        body: { createdOrganizationsCount: result.value },
      };
    }

    const rateLimit = clerkRateLimit(result.error);
    if (!rateLimit) {
      throw result.error;
    }
    set(setResHeader$, "Retry-After", String(rateLimit.retryAfterSeconds));
    set(setResHeader$, "Cache-Control", "no-store");
    return providerUnavailable(
      "Organization creation status is temporarily unavailable",
    );
  },
);

const updateOrgInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return badRequestMessage("No organization is selected for this request");
  }

  const bodyResult = await get(bodyResultOf(orgContract.update));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    updateOrg$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      name: bodyResult.data.name,
    },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in result) {
    return result;
  }

  return {
    status: 200 as const,
    body: {
      id: result.id,
      name: result.name,
      tier: result.tier,
    },
  };
});

const leaveOrgBody$ = bodyResultOf(orgLeaveContract.leave);

const leaveOrgInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(leaveOrgBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    leaveOrg$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      role: auth.orgRole ?? "member",
    },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

const membersInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(orgMembersContract.members));
  const result = await settle(
    set(
      orgMembersList$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        // Fall back to "member" when the auth context lacks an explicit role
        // (rare: run-scoped tokens whose membership lookup returned no role).
        callerRole: auth.orgRole ?? "member",
        includeManagement: query.view !== "members",
      },
      signal,
    ),
    signal,
  );
  if (result.ok) {
    return { status: 200 as const, body: result.value };
  }

  const rateLimit = clerkRateLimit(result.error);
  if (!rateLimit) {
    throw result.error;
  }
  set(setResHeader$, "Retry-After", String(rateLimit.retryAfterSeconds));
  set(setResHeader$, "Cache-Control", "no-store");
  return providerUnavailable(
    "Organization members are temporarily unavailable",
  );
});

export const orgReadRoutes: readonly RouteEntry[] = [
  {
    route: orgContract.get,
    handler: authRoute({ acceptAnySandboxCapability: true }, getOrgInner$),
  },
  {
    route: orgContract.createdCount,
    handler: authRoute(
      { accept: ["session"] },
      getCreatedOrganizationsCountInner$,
    ),
  },
  {
    route: orgContract.update,
    handler: authRoute({}, updateOrgInner$),
  },
  {
    route: orgLeaveContract.leave,
    handler: authRoute({ requireOrganization: true }, leaveOrgInner$),
  },
  {
    route: orgMembersContract.members,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      membersInner$,
    ),
  },
];
