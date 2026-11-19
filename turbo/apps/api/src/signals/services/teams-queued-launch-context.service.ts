import { teamsAccountOwnerCondition } from "./teams-workspace-identity.service";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@okouai/db/runtime/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { and, eq } from "drizzle-orm";

import { command, computed } from "ccstate";
import { db$ } from "../external/db";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";
import { appendTeamsFilesToPrompt, buildTeamsPrompt } from "./teams-prompt";

export interface TeamsQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
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
    row.connectionId === null ||
    row.threadContext === null ||
    row.messageText === null ||
    row.messageFiles === null
  ) {
    return null;
  }
  return {
    ...row,
    threadId: row.threadId,
    serviceUrl: row.serviceUrl,
    senderUserId: row.senderUserId,
    connectionId: row.connectionId,
    threadContext: row.threadContext,
    messageText: row.messageText,
    messageFiles: row.messageFiles,
  };
}

export type TeamsThreadContext = ReturnType<typeof requiredTeamsLaunchContext>;

interface TeamsLaunchSource {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly contextId?: string;
}

export function createTeamsLaunchContext(args: TeamsLaunchSource) {
  return computed(async (get): Promise<TeamsThreadContext> => {
    const db = get(db$);
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
          teamsAccountOwnerCondition({
            orgId: args.orgId,
            userId: args.userId,
          }),
        ),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          eq(chatEvents.contextType, "teams"),
          args.contextId === undefined
            ? undefined
            : eq(chatTeamsContext.id, args.contextId),
        ),
      )
      .limit(1);
    return requiredTeamsLaunchContext(row);
  });
}

function promptFiles(context: {
  readonly messageFiles: NonNullable<
    typeof chatTeamsContext.$inferSelect.messageFiles
  >;
}) {
  // messageFiles also retains fetched context files for delivery. Only the
  // current message's files belong to the agent prompt.
  return context.messageFiles.filter((file) => {
    return file.inCurrentMessage;
  });
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

export function teamsPromptFromContext(
  context: NonNullable<TeamsThreadContext>,
  featureSwitchContext: FeatureSwitchContext,
) {
  return {
    prompt: appendTeamsFilesToPrompt(context.messageText, promptFiles(context)),
    appendSystemPrompt: buildTeamsPrompt({
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
      botId: context.installationBotId,
      botName: context.installationBotName,
      integrationNote: resolveIntegrationNotePrompt({
        triggerSource: "teams",
        featureSwitchContext,
      }),
      threadContext: context.threadContext,
    }),
  };
}

export function teamsDeliveryFromContext(
  context: NonNullable<TeamsThreadContext>,
) {
  return teamsDeliveryTargetSchema.parse({
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
    botId: context.installationBotId,
    botName: context.installationBotName,
    files: context.messageFiles.map((file) => {
      return { fileId: file.fileId, ...file.payload };
    }),
  });
}

export function createTeamsQueuedDelivery(args: TeamsLaunchSource) {
  const context$ = createTeamsLaunchContext(args);
  return computed(async (get) => {
    const context = await get(context$);
    return context ? teamsDeliveryFromContext(context) : null;
  });
}

export const loadTeamsQueuedLaunchMaterial$ = command(
  async (
    { get },
    args: TeamsLaunchSource & {
      readonly featureSwitchContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<TeamsQueuedLaunchMaterial | null> => {
    signal.throwIfAborted();
    const context = await get(createTeamsLaunchContext(args));
    signal.throwIfAborted();
    if (!context) {
      return null;
    }
    return {
      ...teamsPromptFromContext(context, args.featureSwitchContext),
      teamsDelivery: teamsDeliveryFromContext(context),
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
  },
);
