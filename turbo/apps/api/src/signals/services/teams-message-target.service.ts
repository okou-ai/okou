import { teamsAccountOwnerCondition } from "./teams-workspace-identity.service";
import { teamsOrgConnections } from "@okouai/db/runtime/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { eq } from "drizzle-orm";
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
  readonly recipientId?: string;
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

const resolveTeamsMessageConnection$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const connections = await get(db$)
      .select({
        teamsUserId: teamsOrgConnections.teamsUserId,
        teamsAadObjectId: teamsOrgConnections.teamsAadObjectId,
        tenantId: teamsOrgConnections.teamsTenantId,
        teamsUserDisplayName: teamsOrgConnections.teamsUserDisplayName,
      })
      .from(teamsOrgConnections)
      .leftJoin(
        teamsOrgInstallations,
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
      )
      .where(teamsAccountOwnerCondition(args))
      .limit(2);
    signal.throwIfAborted();
    const connection = connections.length === 1 ? connections[0] : undefined;
    return connection;
  },
);

/** Resolve shared conversations or explicitly addressed outbound bot DMs. */
export const resolveTeamsMessageTarget$ = command(
  async (
    { set },
    args: {
      readonly installation: TeamsInstallation;
      readonly userId: string;
      readonly orgId: string;
      readonly mode?: "read" | "write";
      /** Trusted persisted DM recipient, never taken from completion input. */
      readonly recipientId?: string;
      readonly body: {
        readonly conversationId?: string;
        readonly user?: string;
        readonly activityId?: string;
      };
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageTarget | ReturnType<typeof routeError>> => {
    const connection = await set(resolveTeamsMessageConnection$, args, signal);
    if (
      !connection?.teamsUserId ||
      connection.tenantId !== args.installation.teamsTenantId ||
      !args.installation.serviceUrl
    ) {
      return routeError(
        404,
        "This Teams conversation is unavailable to your connected account and Okou.",
        "NOT_FOUND",
      );
    }
    let conversationId = args.body.conversationId;
    let memberId = args.recipientId ?? connection.teamsUserId;
    if (!conversationId) {
      if (
        !args.installation.botId ||
        !args.body.user ||
        (args.mode === "read" &&
          args.body.user !== "me" &&
          args.body.user !== connection.teamsUserId)
      ) {
        return routeError(
          404,
          "This Teams conversation is unavailable to your connected account and Okou.",
          "NOT_FOUND",
        );
      }
      memberId =
        args.body.user === "me" ? connection.teamsUserId : args.body.user;
      const conversation = await createTeamsPersonalConversation(
        {
          serviceUrl: args.installation.serviceUrl,
          tenantId: args.installation.teamsTenantId,
          botId: args.installation.botId,
          botName: args.installation.botName,
          teamsUserId: memberId,
          teamsUserDisplayName:
            memberId === connection.teamsUserId
              ? connection.teamsUserDisplayName
              : null,
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
        teamsUserId: memberId,
        ...(memberId === connection.teamsUserId && connection.teamsAadObjectId
          ? { aadObjectId: connection.teamsAadObjectId }
          : {}),
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
    return {
      conversationId,
      activityId: args.body.activityId,
      recipientId: args.body.user ? memberId : args.recipientId,
    };
  },
);
