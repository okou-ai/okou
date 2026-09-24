import { isIntegrationDmSessionKey } from "../../lib/integration-dm-session";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import {
  type QueuedLaunchContextArgs,
  warnMissingQueuedLaunchEnrichment,
} from "./queued-launch-enrichment.service";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import { buildTeamsPrompt } from "./teams-prompt";

export interface TeamsQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly publicBrand: PublicBrand;
  readonly teamsDelivery: TeamsDeliveryTarget;
  readonly userInfoExtras: {
    readonly teamsUserDisplayName?: string;
    readonly teamsUserPrincipalName?: string;
    readonly teamsUserId: string;
  };
}

type TeamsLaunchContextRow = Pick<
  typeof chatTeamsContext.$inferSelect,
  | "tenantId"
  | "tenantName"
  | "teamId"
  | "teamName"
  | "channelId"
  | "conversationId"
  | "conversationType"
  | "threadId"
  | "activityId"
  | "serviceUrl"
  | "teamsAppId"
  | "publicBrand"
  | "senderUserId"
  | "senderDisplayName"
  | "senderPrincipalName"
  | "connectionId"
  | "threadContext"
  | "messageText"
  | "messageFiles"
> & {
  readonly installationBotId: string | null;
  readonly installationBotName: string | null;
};

function requiredTeamsLaunchContext(row: TeamsLaunchContextRow | undefined) {
  if (
    !row ||
    row.threadId === null ||
    row.serviceUrl === null ||
    row.senderUserId === null ||
    row.connectionId === null
  ) {
    return null;
  }
  return {
    ...row,
    enrichmentMissing:
      row.threadContext === null ||
      row.messageText === null ||
      row.messageFiles === null,
    threadId: row.threadId,
    serviceUrl: row.serviceUrl,
    senderUserId: row.senderUserId,
    connectionId: row.connectionId,
    threadContext: row.threadContext ?? "",
    messageText: row.messageText ?? "",
    messageFiles: row.messageFiles ?? [],
  };
}

async function loadTeamsLaunchContext(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [row] = await db
    .select({
      tenantId: chatTeamsContext.tenantId,
      tenantName: chatTeamsContext.tenantName,
      teamId: chatTeamsContext.teamId,
      teamName: chatTeamsContext.teamName,
      channelId: chatTeamsContext.channelId,
      conversationId: chatTeamsContext.conversationId,
      conversationType: chatTeamsContext.conversationType,
      threadId: chatTeamsContext.threadId,
      activityId: chatTeamsContext.activityId,
      serviceUrl: chatTeamsContext.serviceUrl,
      teamsAppId: chatTeamsContext.teamsAppId,
      publicBrand: chatTeamsContext.publicBrand,
      senderUserId: chatTeamsContext.senderUserId,
      senderDisplayName: chatTeamsContext.senderDisplayName,
      senderPrincipalName: chatTeamsContext.senderPrincipalName,
      connectionId: chatTeamsContext.connectionId,
      threadContext: chatTeamsContext.threadContext,
      messageText: chatTeamsContext.messageText,
      messageFiles: chatTeamsContext.messageFiles,
      installationBotId: teamsOrgInstallations.botId,
      installationBotName: teamsOrgInstallations.botName,
    })
    .from(chatEvents)
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
        eq(teamsOrgConnections.id, chatTeamsContext.connectionId),
        eq(teamsOrgConnections.teamsTenantId, chatTeamsContext.tenantId),
        eq(teamsOrgConnections.userId, args.userId),
      ),
    )
    .innerJoin(
      teamsOrgInstallations,
      and(
        eq(teamsOrgInstallations.teamsTenantId, chatTeamsContext.tenantId),
        eq(teamsOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "teams"),
      ),
    )
    .limit(1);
  return requiredTeamsLaunchContext(row);
}

function promptThreadId(context: {
  readonly conversationType: string | null;
  readonly threadId: string;
  readonly activityId: string | null;
}): string {
  if (
    context.conversationType === "personal" &&
    context.activityId &&
    context.threadId.startsWith("direct-message:")
  ) {
    return context.activityId;
  }
  return context.threadId;
}

async function loadTeamsRouteLaunchMaterial(
  db: Db,
  args: QueuedLaunchContextArgs,
): Promise<TeamsQueuedLaunchMaterial | null> {
  const [route] = await db
    .select({
      tenantId: teamsOrgInstallations.teamsTenantId,
      tenantName: teamsOrgInstallations.teamsTenantName,
      teamId: teamsOrgInstallations.teamsTeamId,
      teamName: teamsOrgInstallations.teamsTeamName,
      channelId: teamsChatThreadRoutes.channelId,
      conversationId: teamsChatThreadRoutes.conversationId,
      conversationType: teamsChatThreadRoutes.conversationType,
      threadId: teamsChatThreadRoutes.threadId,
      serviceUrl: teamsChatThreadRoutes.serviceUrl,
      installationServiceUrl: teamsOrgInstallations.serviceUrl,
      connectionId: teamsOrgConnections.id,
      teamsUserId: teamsOrgConnections.teamsUserId,
      teamsUserDisplayName: teamsOrgConnections.teamsUserDisplayName,
      teamsUserPrincipalName: teamsOrgConnections.teamsUserPrincipalName,
      botId: teamsOrgInstallations.botId,
      botName: teamsOrgInstallations.botName,
      publicBrand: teamsOrgInstallations.publicBrand,
    })
    .from(chatEvents)
    .innerJoin(
      teamsChatThreadRoutes,
      and(
        eq(teamsChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(teamsChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      teamsOrgConnections,
      and(
        eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
        eq(teamsOrgConnections.userId, args.userId),
      ),
    )
    .innerJoin(
      teamsOrgInstallations,
      and(
        eq(
          teamsOrgInstallations.teamsTenantId,
          teamsOrgConnections.teamsTenantId,
        ),
        eq(teamsOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "teams"),
      ),
    )
    .limit(1);
  const serviceUrl = route?.serviceUrl ?? route?.installationServiceUrl;
  if (!route?.teamsUserId || !serviceUrl) {
    return null;
  }
  warnMissingQueuedLaunchEnrichment("teams", args);
  return {
    prompt: args.userMessageProjection.agentPrompt,
    appendSystemPrompt: "",
    publicBrand: route.publicBrand,
    teamsDelivery: teamsDeliveryTargetSchema.parse({
      ...route,
      serviceUrl,
      activityId: isIntegrationDmSessionKey(route.threadId)
        ? null
        : route.threadId,
    }),
    userInfoExtras: { teamsUserId: route.teamsUserId },
  };
}

export async function loadTeamsQueuedLaunchMaterial(
  db: Db,
  args: QueuedLaunchContextArgs,
): Promise<TeamsQueuedLaunchMaterial | null> {
  const context = await loadTeamsLaunchContext(db, args);
  if (!context) {
    return loadTeamsRouteLaunchMaterial(db, args);
  }
  if (context.enrichmentMissing) {
    warnMissingQueuedLaunchEnrichment("teams", args);
  }
  const botId = context.installationBotId;
  const botName = context.installationBotName;
  return {
    prompt: args.userMessageProjection.agentPrompt,
    appendSystemPrompt: context.enrichmentMissing
      ? ""
      : buildTeamsPrompt({
          tenantId: context.tenantId,
          tenantName: context.tenantName,
          teamId: context.teamId,
          teamName: context.teamName,
          channelId: context.channelId,
          conversationId: context.conversationId,
          conversationType: context.conversationType,
          threadId: promptThreadId(context),
          activityId: context.activityId,
          teamsAppId: context.teamsAppId,
          botId,
          botName,
          integrationNote: resolveIntegrationNotePrompt({
            triggerSource: "teams",
            featureSwitchContext: args.featureSwitchContext,
          }),
          threadContext: context.threadContext,
        }),
    publicBrand: context.publicBrand,
    teamsDelivery: teamsDeliveryTargetSchema.parse({
      tenantId: context.tenantId,
      tenantName: context.tenantName,
      teamId: context.teamId,
      teamName: context.teamName,
      channelId: context.channelId,
      conversationId: context.conversationId,
      conversationType: context.conversationType,
      threadId: context.threadId,
      activityId: context.activityId,
      serviceUrl: context.serviceUrl,
      connectionId: context.connectionId,
      teamsUserId: context.senderUserId,
      teamsUserDisplayName: context.senderDisplayName,
      teamsUserPrincipalName: context.senderPrincipalName,
      botId,
      botName,
      publicBrand: context.publicBrand,
      files: context.messageFiles.map((file) => {
        return { fileId: file.fileId, ...file.payload };
      }),
    }),
    userInfoExtras: {
      ...(context.senderDisplayName
        ? { teamsUserDisplayName: context.senderDisplayName }
        : {}),
      ...(context.senderPrincipalName
        ? { teamsUserPrincipalName: context.senderPrincipalName }
        : {}),
      teamsUserId: context.senderUserId,
    },
  };
}
