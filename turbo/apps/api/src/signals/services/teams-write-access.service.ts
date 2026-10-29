import { command } from "ccstate";
import { and, eq, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";

import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { teamsAccountOwnerCondition } from "./teams-workspace-identity.service";
import {
  resolveTeamsMessageTarget$,
  routeError,
} from "./teams-message-target.service";

const revokedInputs = alias(chatEvents, "teams_write_revoked_inputs");

/** Source authority belongs only to an input actually consumed by this Run. */
const sourceInstallation$ = command(
  async (
    { get },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly conversationId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const [source] = await db
      .select({ installation: teamsOrgInstallations })
      .from(agentRuns)
      .innerJoin(
        chatEvents,
        and(
          eq(chatEvents.runId, agentRuns.id),
          eq(chatEvents.chatThreadId, agentRuns.chatThreadId),
          eq(chatEvents.eventType, "input.prompt"),
          eq(chatEvents.contextType, "teams"),
        ),
      )
      .innerJoin(
        chatTeamsContext,
        and(
          eq(chatTeamsContext.id, chatEvents.contextId),
          eq(chatTeamsContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .innerJoin(
        teamsChatThreadRoutes,
        and(
          eq(teamsChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
          eq(teamsChatThreadRoutes.connectionId, chatTeamsContext.connectionId),
          eq(
            teamsChatThreadRoutes.conversationId,
            chatTeamsContext.conversationId,
          ),
          eq(teamsChatThreadRoutes.threadId, chatTeamsContext.threadId),
          eq(teamsChatThreadRoutes.userId, args.userId),
        ),
      )
      .innerJoin(
        teamsOrgConnections,
        and(
          eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
          eq(teamsOrgConnections.teamsTenantId, chatTeamsContext.tenantId),
          eq(teamsOrgConnections.teamsUserId, chatTeamsContext.senderUserId),
        ),
      )
      .innerJoin(
        teamsOrgInstallations,
        eq(teamsOrgInstallations.teamsTenantId, chatTeamsContext.tenantId),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.orgId, args.orgId),
          teamsAccountOwnerCondition(args),
          eq(chatTeamsContext.conversationId, args.conversationId),
          notExists(
            db
              .select({ id: revokedInputs.id })
              .from(revokedInputs)
              .where(eq(revokedInputs.revokesEventId, chatEvents.id)),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return source?.installation;
  },
);

/** Choose the execution organization's installation, or the exact Run source. */
export const resolveTeamsWriteTarget$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
      readonly tenantId?: string;
      readonly allowSource?: boolean;
      readonly sourceOnly?: boolean;
      readonly body: {
        readonly conversationId?: string;
        readonly user?: string;
        readonly activityId?: string;
      };
    },
    signal: AbortSignal,
  ) => {
    const features = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    const source =
      isFeatureEnabled(FeatureSwitchKey.TeamsWorkspaceIdentity, features) &&
      args.allowSource !== false &&
      args.runId &&
      args.body.conversationId &&
      !args.body.user
        ? await set(
            sourceInstallation$,
            {
              ...args,
              runId: args.runId,
              conversationId: args.body.conversationId,
            },
            signal,
          )
        : undefined;
    if (args.sourceOnly && !source) {
      return routeError(
        404,
        "The Teams source conversation is no longer authorized for this Run",
        "NOT_FOUND",
      );
    }
    const [ownInstallation] = source
      ? []
      : await get(db$)
          .select()
          .from(teamsOrgInstallations)
          .where(eq(teamsOrgInstallations.orgId, args.orgId))
          .limit(1);
    signal.throwIfAborted();
    const installation = source ?? ownInstallation;
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
    if (args.tenantId && installation.teamsTenantId !== args.tenantId) {
      return routeError(
        404,
        "No Microsoft Teams installation found for this authorized destination",
        "NOT_FOUND",
      );
    }
    const target = await set(
      resolveTeamsMessageTarget$,
      {
        installation,
        orgId: args.orgId,
        userId: args.userId,
        body: args.body,
      },
      signal,
    );
    if ("status" in target) {
      return target;
    }
    return {
      ...target,
      source: Boolean(source),
      installation: { ...installation, serviceUrl: installation.serviceUrl },
    };
  },
);
