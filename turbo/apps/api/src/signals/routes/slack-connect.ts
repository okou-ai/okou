import { command, computed } from "ccstate";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$ } from "../external/db";
import { getOAuthApiOrigin } from "../../lib/oauth-origin";
import { buildSlackConnectorOAuthStartUrl } from "../services/slack-connector-oauth-state";
import { slackConnectStatus } from "../services/slack-connect.service";
import type { RouteEntry } from "../route-entry";

const getSlackConnectStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    slackConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: "orgRole" in auth && auth.orgRole === "admin",
    }),
  );
  return { status: 200 as const, body };
});

const startConnectorOAuth$ = command(
  async (
    { get },
    body: {
      readonly workspaceId: string;
      readonly slackUserId: string;
      readonly channelId?: string;
      readonly threadTs?: string;
    },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const [installation] = await get(db$)
      .select({ orgId: slackOrgInstallations.orgId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, body.workspaceId))
      .limit(1);
    signal.throwIfAborted();
    if (
      !installation ||
      (installation.orgId !== null && installation.orgId !== auth.orgId)
    ) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Slack workspace not found", code: "NOT_FOUND" },
        },
      };
    }
    if (installation.orgId === null && auth.orgRole !== "admin") {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Only admins can connect a Slack workspace",
            code: "FORBIDDEN",
          },
        },
      };
    }
    return {
      status: 202 as const,
      body: {
        authorizationUrl: buildSlackConnectorOAuthStartUrl(
          getOAuthApiOrigin(get(request$).raw),
          {
            flow: "connect",
            orgId: auth.orgId,
            userId: auth.userId,
            workspaceId: body.workspaceId,
            slackUserId: body.slackUserId,
            channelId: body.channelId,
            threadTs: body.threadTs,
          },
        ),
      },
    };
  },
);

const connectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(bodyResultOf(slackConnectContract.connect));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  return await set(startConnectorOAuth$, bodyResult.data, signal);
});

const slackConnectAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const slackConnectWriteAuth = {
  ...slackConnectAuth,
  requiredCapability: "slack:write",
} as const;

export const slackConnectRoutes: readonly RouteEntry[] = [
  {
    route: slackConnectContract.getStatus,
    handler: authRoute(slackConnectAuth, getSlackConnectStatusInner$),
  },
  {
    route: slackConnectContract.connect,
    handler: authRoute(slackConnectWriteAuth, connectInner$),
  },
];
