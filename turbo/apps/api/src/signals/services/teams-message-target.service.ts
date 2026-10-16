import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq } from "drizzle-orm";
import { command, computed, type Computed } from "ccstate";

import { db$ } from "../external/db";
import { createTeamsPersonalConversation } from "../external/teams-bot-client";

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

type ConnectedTeamsUser =
  | {
      readonly kind: "ok";
      readonly teamsUserId: string;
      readonly teamsUserDisplayName: string | null;
    }
  | { readonly kind: "not_found" };

/**
 * Resolve a Teams delivery target. A `conversationId` is used as-is; a `user`
 * (Teams user ID, or `"me"` for the caller's connected Teams user) is resolved
 * to the bot's personal conversation with that user.
 */
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

    let targetUser: ConnectedTeamsUser;
    if (args.body.user === "me") {
      const db = get(db$);
      const tenantId = args.installation.teamsTenantId;
      const userId = args.userId;
      targetUser = await (async (): Promise<ConnectedTeamsUser> => {
        const [connection] = await db
          .select({
            teamsUserId: teamsOrgConnections.teamsUserId,
            teamsUserDisplayName: teamsOrgConnections.teamsUserDisplayName,
          })
          .from(teamsOrgConnections)
          .where(
            and(
              eq(teamsOrgConnections.teamsTenantId, tenantId),
              eq(teamsOrgConnections.userId, userId),
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
      })();
    } else {
      targetUser = {
        kind: "ok",
        teamsUserId: args.body.user,
        teamsUserDisplayName: null,
      };
    }
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
  },
);
