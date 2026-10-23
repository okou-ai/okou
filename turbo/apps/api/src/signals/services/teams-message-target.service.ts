import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq } from "drizzle-orm";
import { command, computed, type Computed } from "ccstate";

import { db$ } from "../external/db";
import {
  createTeamsPersonalConversation,
  checkTeamsConversationMember,
} from "../external/teams-bot-client";

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

export function routeError<Status extends 400 | 401 | 403 | 404 | 502>(
  status: Status,
  message: string,
  code: string,
) {
  return { status, body: { error: { message, code } } };
}

export function teamsInstallation(
  orgId$: Computed<string>,
): Computed<Promise<TeamsInstallation | undefined>> {
  return computed(async (get) => {
    const orgId = get(orgId$);
    const db = get(db$);
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
  });
}

export function teamsErrorResponse(result: {
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

/** Resolve only conversations shared by the connected user and this bot. */
export const resolveTeamsMessageTarget$ = command(
  async (
    { get },
    args: {
      readonly installation: TeamsInstallation;
      readonly userId: string;
      readonly body: {
        readonly conversationId?: string;
        readonly user?: string;
        readonly activityId?: string;
      };
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageTarget | ReturnType<typeof routeError>> => {
    const [connection] = await get(db$)
      .select({
        teamsUserId: teamsOrgConnections.teamsUserId,
        teamsUserDisplayName: teamsOrgConnections.teamsUserDisplayName,
      })
      .from(teamsOrgConnections)
      .where(
        and(
          eq(
            teamsOrgConnections.teamsTenantId,
            args.installation.teamsTenantId,
          ),
          eq(teamsOrgConnections.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!connection?.teamsUserId || !args.installation.serviceUrl) {
      return routeError(
        404,
        "This Teams conversation is unavailable to your connected account and Okou.",
        "NOT_FOUND",
      );
    }
    let conversationId = args.body.conversationId;
    if (!conversationId) {
      if (
        !args.installation.botId ||
        !args.body.user ||
        (args.body.user !== "me" && args.body.user !== connection.teamsUserId)
      ) {
        return routeError(
          404,
          "This Teams conversation is unavailable to your connected account and Okou.",
          "NOT_FOUND",
        );
      }
      const conversation = await createTeamsPersonalConversation(
        {
          serviceUrl: args.installation.serviceUrl,
          tenantId: args.installation.teamsTenantId,
          botId: args.installation.botId,
          botName: args.installation.botName,
          teamsUserId: connection.teamsUserId,
          teamsUserDisplayName: connection.teamsUserDisplayName,
        },
        signal,
      );
      if (conversation.kind === "teams-error") {
        return teamsErrorResponse(conversation);
      }
      conversationId = conversation.conversationId;
    }
    const membership = await checkTeamsConversationMember(
      {
        serviceUrl: args.installation.serviceUrl,
        tenantId: args.installation.teamsTenantId,
        conversationId,
        teamsUserId: connection.teamsUserId,
      },
      signal,
    );
    if (membership.kind === "teams-error") {
      return teamsErrorResponse(membership);
    }
    if (membership.kind === "denied") {
      return routeError(
        404,
        "This Teams conversation is unavailable to your connected account and Okou.",
        "NOT_FOUND",
      );
    }
    return { conversationId, activityId: args.body.activityId };
  },
);
