import { command } from "ccstate";
import { integrationsTeamsMessageContract } from "@okouai/api-contracts/contracts/integrations";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq } from "drizzle-orm";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { snapshotIntegrationMessage$ } from "../services/integration-artifact-message.service";
import { db$, type ReadonlyDb } from "../external/db";
import {
  createTeamsPersonalConversation,
  sendTeamsMessage,
} from "../external/teams-bot-client";
import type { RouteEntry } from "../route-entry";

interface TeamsInstallation {
  readonly teamsTenantId: string;
  readonly serviceUrl: string | null;
  readonly botId: string | null;
  readonly botName: string | null;
}

interface TeamsMessageTarget {
  readonly conversationId: string;
  readonly activityId: string | undefined;
}

function routeError<Status extends 400 | 401 | 403 | 404 | 502>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

async function loadInstallation(
  db: ReadonlyDb,
  orgId: string,
): Promise<TeamsInstallation | undefined> {
  const [installation] = await db
    .select({
      teamsTenantId: teamsOrgInstallations.teamsTenantId,
      serviceUrl: teamsOrgInstallations.serviceUrl,
      botId: teamsOrgInstallations.botId,
      botName: teamsOrgInstallations.botName,
    })
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.orgId, orgId))
    .limit(1);
  return installation;
}

function teamsErrorResponse(result: {
  readonly kind: "teams-error";
  readonly status: number;
  readonly error: string;
}) {
  return routeError(
    result.status >= 500 ? 502 : 400,
    `Microsoft Teams API error: ${result.error}`,
    "TEAMS_ERROR",
  );
}

async function resolveConnectedTeamsUser(args: {
  readonly db: ReadonlyDb;
  readonly tenantId: string;
  readonly userId: string;
}): Promise<
  | {
      readonly kind: "ok";
      readonly teamsUserId: string;
      readonly teamsUserDisplayName: string | null;
    }
  | { readonly kind: "not_found" }
> {
  const [connection] = await args.db
    .select({
      teamsUserId: teamsOrgConnections.teamsUserId,
      teamsUserDisplayName: teamsOrgConnections.teamsUserDisplayName,
    })
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, args.tenantId),
        eq(teamsOrgConnections.userId, args.userId),
      ),
    )
    .limit(1);

  if (!connection?.teamsUserId) {
    return { kind: "not_found" };
  }

  return {
    kind: "ok",
    teamsUserId: connection.teamsUserId,
    teamsUserDisplayName: connection.teamsUserDisplayName,
  };
}

async function resolveTeamsMessageTarget(
  args: {
    readonly db: ReadonlyDb;
    readonly installation: TeamsInstallation;
    readonly userId: string;
    readonly body: {
      readonly conversationId?: string;
      readonly user?: string;
      readonly activityId?: string;
    };
  },
  signal: AbortSignal,
): Promise<TeamsMessageTarget | ReturnType<typeof routeError>> {
  if (args.body.conversationId) {
    return {
      conversationId: args.body.conversationId,
      activityId: args.body.activityId,
    };
  }

  if (!args.installation.botId) {
    return routeError(
      404,
      "Microsoft Teams installation has no bot identity yet. Send a message to the Teams bot first.",
      "NOT_FOUND",
    );
  }
  if (!args.installation.serviceUrl) {
    return routeError(
      404,
      "Microsoft Teams installation has no service URL yet. Send a message to the Teams bot first.",
      "NOT_FOUND",
    );
  }
  if (!args.body.user) {
    return routeError(400, "Teams user ID is required", "BAD_REQUEST");
  }

  const targetUser =
    args.body.user === "me"
      ? await resolveConnectedTeamsUser({
          db: args.db,
          tenantId: args.installation.teamsTenantId,
          userId: args.userId,
        })
      : {
          kind: "ok" as const,
          teamsUserId: args.body.user,
          teamsUserDisplayName: null,
        };
  signal.throwIfAborted();

  if (targetUser.kind === "not_found") {
    return routeError(
      404,
      "No connected Microsoft Teams user found for this organization",
      "NOT_FOUND",
    );
  }

  const conversation = await createTeamsPersonalConversation(
    {
      serviceUrl: args.installation.serviceUrl,
      tenantId: args.installation.teamsTenantId,
      botId: args.installation.botId,
      botName: args.installation.botName,
      teamsUserId: targetUser.teamsUserId,
      teamsUserDisplayName: targetUser.teamsUserDisplayName,
    },
    signal,
  );
  signal.throwIfAborted();

  if (conversation.kind === "teams-error") {
    return teamsErrorResponse(conversation);
  }

  return {
    conversationId: conversation.conversationId,
    activityId: undefined,
  };
}

const sendMessageInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(
    bodyResultOf(integrationsTeamsMessageContract.sendMessage),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.data;

  const db = get(db$);
  const installation = await loadInstallation(db, auth.orgId);
  signal.throwIfAborted();
  if (!installation) {
    return routeError(
      404,
      "No Microsoft Teams installation found for this organization",
      "NOT_FOUND",
    );
  }
  if (!installation.serviceUrl) {
    return routeError(
      404,
      "Microsoft Teams installation has no service URL yet. Send a message to the Teams bot first.",
      "NOT_FOUND",
    );
  }

  const target = await resolveTeamsMessageTarget(
    {
      db,
      installation,
      userId: auth.userId,
      body,
    },
    signal,
  );
  signal.throwIfAborted();
  if ("status" in target) {
    return target;
  }

  const outbound = integrationsTeamsMessageContract.sendMessage.body.parse({
    ...body,
    ...(await set(
      snapshotIntegrationMessage$,
      {
        content: { text: body.text, card: body.card },
      },
      signal,
    )),
  });
  signal.throwIfAborted();

  const result = await sendTeamsMessage(
    {
      serviceUrl: installation.serviceUrl,
      conversationId: target.conversationId,
      activityId: target.activityId,
      tenantId: installation.teamsTenantId,
      text: outbound.text ?? "Adaptive card",
      card: outbound.card,
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "teams-error") {
    return teamsErrorResponse(result);
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      activityId: result.activityId,
      conversationId: target.conversationId,
    },
  };
});

const teamsWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "teams:write",
} as const;

export const integrationsTeamsMessageRoutes: readonly RouteEntry[] = [
  {
    route: integrationsTeamsMessageContract.sendMessage,
    handler: authRoute(teamsWriteAuth, sendMessageInner$),
  },
];
