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
      .where(teamsAccountOwnerCondition(args))
      .limit(2);
    signal.throwIfAborted();
    const connection = connections.length === 1 ? connections[0] : undefined;
    return connection;
  },
);

const resolvePersonalTeamsConversation$ = command(
  async (
    _ctx,
    args: {
      readonly installation: TeamsInstallation & {
        readonly serviceUrl: string;
      };
      readonly connection: {
        readonly teamsUserId: string;
        readonly teamsUserDisplayName: string | null;
      };
      readonly mode?: "read" | "write";
      readonly preflight?: boolean;
      readonly user?: string;
      readonly activityId?: string;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "preflight"; readonly target: TeamsMessageTarget }
    | {
        readonly kind: "resolved";
        readonly conversationId: string;
        readonly memberId: string;
      }
    | ReturnType<typeof routeError>
  > => {
    if (
      !args.installation.botId ||
      !args.user ||
      (args.mode === "read" &&
        args.user !== "me" &&
        args.user !== args.connection.teamsUserId)
    ) {
      return routeError(
        404,
        "This Teams conversation is unavailable to your connected account and Okou.",
        "NOT_FOUND",
      );
    }
    const memberId =
      args.user === "me" ? args.connection.teamsUserId : args.user;
    if (args.preflight) {
      return {
        kind: "preflight",
        target: {
          conversationId: "",
          activityId: args.activityId,
          recipientId: memberId,
        },
      };
    }
    const conversation = await createTeamsPersonalConversation(
      {
        serviceUrl: args.installation.serviceUrl,
        tenantId: args.installation.teamsTenantId,
        botId: args.installation.botId,
        botName: args.installation.botName,
        teamsUserId: memberId,
        teamsUserDisplayName:
          memberId === args.connection.teamsUserId
            ? args.connection.teamsUserDisplayName
            : null,
      },
      signal,
    );
    if (conversation.kind === "teams-error") {
      return teamsErrorResponse(conversation);
    }
    return {
      kind: "resolved",
      conversationId: conversation.conversationId,
      memberId,
    };
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
      /** Skip creating a Bot Framework personal conversation during upload init preflight. */
      readonly preflight?: boolean;
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
      const personal = await set(
        resolvePersonalTeamsConversation$,
        {
          installation: {
            ...args.installation,
            serviceUrl: args.installation.serviceUrl,
          },
          connection: {
            teamsUserId: connection.teamsUserId,
            teamsUserDisplayName: connection.teamsUserDisplayName,
          },
          mode: args.mode,
          preflight: args.preflight,
          user: args.body.user,
          activityId: args.body.activityId,
        },
        signal,
      );
      if ("status" in personal) {
        return personal;
      }
      if (personal.kind === "preflight") {
        return personal.target;
      }
      conversationId = personal.conversationId;
      memberId = personal.memberId;
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
