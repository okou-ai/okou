import { command, computed } from "ccstate";
import { slackConnectContract } from "@okouai/api-contracts/contracts/slack-connect";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, queryOf } from "../context/request";
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

const getSlackConnectLinkStatusInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(slackConnectContract.getLinkStatus));
  const body = await get(
    slackConnectStatus({
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: "orgRole" in auth && auth.orgRole === "admin",
      workspaceId: query.workspaceId,
      slackUserId: query.slackUserId,
    }),
  );
  return { status: 200 as const, body };
});

const startConnectorOAuth$ = command(
  async (
    { get },
    args: {
      readonly flow: "connect" | "switch";
      readonly body: {
        readonly workspaceId: string;
        readonly slackUserId: string;
        readonly channelId?: string;
        readonly threadTs?: string;
      };
    },
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const [installation] = await get(db$)
      .select({ orgId: slackOrgInstallations.orgId })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, args.body.workspaceId))
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
            flow: args.flow,
            orgId: auth.orgId,
            userId: auth.userId,
            workspaceId: args.body.workspaceId,
            slackUserId: args.body.slackUserId,
            channelId: args.body.channelId,
            threadTs: args.body.threadTs,
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

  return await set(
    startConnectorOAuth$,
    { flow: "connect", body: bodyResult.data },
    signal,
  );
});

const switchAccountInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(
      bodyResultOf(slackConnectContract.switchAccount),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    return await set(
      startConnectorOAuth$,
      { flow: "switch", body: bodyResult.data },
      signal,
    );
  },
);

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
    route: slackConnectContract.getLinkStatus,
    handler: authRoute(slackConnectAuth, getSlackConnectLinkStatusInner$),
  },
  {
    route: slackConnectContract.connect,
    handler: authRoute(slackConnectWriteAuth, connectInner$),
  },
  {
    route: slackConnectContract.switchAccount,
    handler: authRoute(slackConnectWriteAuth, switchAccountInner$),
  },
];
