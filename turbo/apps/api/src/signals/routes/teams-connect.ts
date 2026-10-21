import { command, computed } from "ccstate";
import { teamsConnectContract } from "@okouai/api-contracts/contracts/teams-connect";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
import {
  connectTeamsInstallation$,
  disconnectTeamsConnection$,
  publishTeamsChanged$,
  uninstallTeamsInstallation$,
  teamsConnectStatus,
} from "../services/teams-connect.service";
import type { RouteEntry } from "../route-entry";
import { createTeamsOAuthState$ } from "../services/teams-oauth-state";

function errorResponse(
  status: 403 | 404,
  message: string,
  code: "FORBIDDEN" | "NOT_FOUND",
) {
  return {
    status,
    body: {
      error: { message, code },
    },
  };
}

const teamsConnectStatusIdentity$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    isAdmin: "orgRole" in auth && auth.orgRole === "admin",
  };
});
const teamsConnectStatus$ = teamsConnectStatus(teamsConnectStatusIdentity$);

const getTeamsConnectStatusInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const body = await get(teamsConnectStatus$);
    signal.throwIfAborted();
    if (!body.connectUrl) {
      return { status: 200 as const, body };
    }
    const auth = get(organizationAuthContext$);
    const url = new URL(body.connectUrl);
    const connectState = await set(
      createTeamsOAuthState$,
      {
        purpose: "teams-start",
        userId: auth.userId,
        orgId: auth.orgId,
        redirectUri: new URL(
          "/api/integrations/teams/oauth/callback",
          url,
        ).toString(),
        prompt: null,
      },
      signal,
    );
    url.search = new URLSearchParams({ connectState }).toString();
    return {
      status: 200 as const,
      body: { ...body, connectUrl: url.toString() },
    };
  },
);

const connectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  signal.throwIfAborted();

  const bodyResult = await get(bodyResultOf(teamsConnectContract.connect));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const result = await set(
    connectTeamsInstallation$,
    {
      userId: auth.userId,
      orgId: auth.orgId,
      orgRole:
        "orgRole" in auth && auth.orgRole === "admin" ? "admin" : "member",
      tenantId: body.tenantId,
      teamsUserId: body.teamsUserId,
      teamsAadObjectId: body.teamsAadObjectId,
      teamsUserDisplayName: body.teamsUserDisplayName,
      teamsUserPrincipalName: body.teamsUserPrincipalName,
      teamId: body.teamId,
      teamName: body.teamName,
      serviceUrl: body.serviceUrl,
      conversationId: body.conversationId,
      conversationType: body.conversationType,
      activityId: body.activityId,
      channelId: body.channelId,
      threadId: body.threadId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return errorResponse(404, result.message, "NOT_FOUND");
  }

  if (result.kind === "forbidden") {
    return errorResponse(403, result.message, "FORBIDDEN");
  }

  await set(
    publishTeamsChanged$,
    { orgId: auth.orgId, userIds: [auth.userId] },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      success: true as const,
      connectionId: result.connectionId,
      role: result.role,
    },
  };
});

const disconnectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(teamsConnectContract.disconnect));

  if (query.action === "uninstall") {
    if (!("orgRole" in auth) || auth.orgRole !== "admin") {
      return errorResponse(403, "Admin access required", "FORBIDDEN");
    }

    const uninstallResult = await set(
      uninstallTeamsInstallation$,
      { orgId: auth.orgId },
      signal,
    );
    signal.throwIfAborted();

    if (uninstallResult.kind === "not_found") {
      return errorResponse(404, uninstallResult.message, "NOT_FOUND");
    }

    await set(
      publishTeamsChanged$,
      {
        orgId: uninstallResult.orgId,
        userIds: [auth.userId, ...uninstallResult.userIds],
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: { success: true as const },
    };
  }

  const result = await set(
    disconnectTeamsConnection$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "not_found") {
    return errorResponse(404, result.message, "NOT_FOUND");
  }

  await set(
    publishTeamsChanged$,
    { orgId: result.orgId, userIds: [result.userId] },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { success: true as const },
  };
});

const teamsConnectAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const teamsConnectRoutes: readonly RouteEntry[] = [
  {
    route: teamsConnectContract.getStatus,
    handler: authRoute(teamsConnectAuth, getTeamsConnectStatusInner$),
  },
  {
    route: teamsConnectContract.connect,
    handler: authRoute(teamsConnectAuth, connectInner$),
  },
  {
    route: teamsConnectContract.disconnect,
    handler: authRoute(teamsConnectAuth, disconnectInner$),
  },
];
