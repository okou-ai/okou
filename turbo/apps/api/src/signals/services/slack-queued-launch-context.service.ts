import { command } from "ccstate";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@okouai/db/schema/slack-org-installation";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";

import {
  buildSlackSystemPrompt,
  canonicalSlackAgentPrompt,
  resolveUserMentions,
} from "../../lib/slack-webhook-context";
import type { SlackUserInfo } from "../external/slack-message-client";
import { db$ } from "../external/db";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

export interface SlackQueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly slackDelivery: {
    readonly workspaceId?: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly userInfoExtras?: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
  };
}

type SlackLaunchContextRow = Pick<
  typeof chatSlackContext.$inferSelect,
  | "channelId"
  | "workspaceId"
  | "botUserId"
  | "conversationContext"
  | "messageText"
  | "messageFiles"
  | "messageAssets"
  | "mentionDisplayNames"
  | "senderDisplayName"
  | "senderUserId"
  | "channelType"
  | "threadTs"
  | "routeThreadTs"
>;

function requiredSlackLaunchContext(row: SlackLaunchContextRow | undefined) {
  if (
    !row ||
    row.channelId === null ||
    row.botUserId === null ||
    row.conversationContext === null ||
    row.messageText === null ||
    row.messageFiles === null ||
    row.messageAssets === null ||
    row.mentionDisplayNames === null ||
    row.channelType === null ||
    row.threadTs === null
  ) {
    return null;
  }
  return {
    ...row,
    channelId: row.channelId,
    botUserId: row.botUserId,
    conversationContext: row.conversationContext,
    messageText: row.messageText,
    messageFiles: row.messageFiles,
    messageAssets: row.messageAssets,
    mentionDisplayNames: row.mentionDisplayNames,
    channelType: row.channelType,
    threadTs: row.threadTs,
  };
}

const loadSlackLaunchContext$ = command(
  async (
    { get },
    args: {
      readonly eventId: string;
      readonly chatThreadId: string;
      readonly orgId: string;
      readonly userId: string;
    },
  ) => {
    const db = get(db$);
    const [row] = await db
      .select({
        channelId: chatSlackContext.channelId,
        workspaceId: chatSlackContext.workspaceId,
        botUserId: chatSlackContext.botUserId,
        conversationContext: chatSlackContext.conversationContext,
        messageText: chatSlackContext.messageText,
        messageFiles: chatSlackContext.messageFiles,
        messageAssets: chatSlackContext.messageAssets,
        mentionDisplayNames: chatSlackContext.mentionDisplayNames,
        senderDisplayName: chatSlackContext.senderDisplayName,
        senderUserId: chatSlackContext.senderUserId,
        channelType: chatSlackContext.channelType,
        threadTs: chatSlackContext.threadTs,
        routeThreadTs: chatSlackContext.routeThreadTs,
      })
      .from(chatEvents)
      .innerJoin(
        chatSlackContext,
        and(
          eq(chatSlackContext.id, chatEvents.contextId),
          eq(chatSlackContext.chatThreadId, chatEvents.chatThreadId),
        ),
      )
      .innerJoin(
        slackChatThreadRoutes,
        and(
          eq(slackChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
          eq(slackChatThreadRoutes.channelId, chatSlackContext.channelId),
          or(
            and(
              isNull(chatSlackContext.routeThreadTs),
              eq(slackChatThreadRoutes.threadTs, chatSlackContext.threadTs),
            ),
            eq(slackChatThreadRoutes.threadTs, chatSlackContext.routeThreadTs),
          ),
          eq(slackChatThreadRoutes.userId, args.userId),
        ),
      )
      .innerJoin(
        slackOrgConnections,
        and(
          eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
          eq(slackOrgConnections.userId, args.userId),
        ),
      )
      .innerJoin(
        slackOrgInstallations,
        and(
          eq(
            slackOrgInstallations.slackWorkspaceId,
            sql`coalesce(${chatSlackContext.workspaceId}, ${slackOrgConnections.slackWorkspaceId})`,
          ),
        ),
      )
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
      )
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatEvents.chatThreadId, args.chatThreadId),
          eq(chatEvents.contextType, "slack"),
        ),
      )
      .limit(1);
    return requiredSlackLaunchContext(row);
  },
);

function mentionUserInfoMap(
  mentionDisplayNames: Readonly<Record<string, string>>,
): Map<string, SlackUserInfo> {
  return new Map(
    Object.entries(mentionDisplayNames).map(([id, name]) => {
      return [id, { id, name }] as const;
    }),
  );
}

export const loadSlackQueuedLaunchMaterial$ = command(
  async (
    { set },
    args: {
      readonly eventId: string;
      readonly chatThreadId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly featureSwitchContext: FeatureSwitchContext;
    },
  ): Promise<SlackQueuedLaunchMaterial | null> => {
    const context = await set(loadSlackLaunchContext$, args);
    if (!context) {
      return null;
    }
    const messagePrompt = resolveUserMentions(
      context.messageText,
      mentionUserInfoMap(context.mentionDisplayNames),
    );
    return {
      prompt: canonicalSlackAgentPrompt(
        messagePrompt,
        context.messageFiles,
        context.messageAssets,
      ),
      appendSystemPrompt: buildSlackSystemPrompt({
        botUserId: context.botUserId,
        channelId: context.channelId,
        channelType: context.channelType,
        threadTs: context.threadTs,
        integrationNote: resolveIntegrationNotePrompt({
          triggerSource: "slack",
          featureSwitchContext: args.featureSwitchContext,
        }),
        executionContext: context.conversationContext,
      }),
      slackDelivery: {
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        channelId: context.channelId,
        threadTs: context.threadTs,
        ...(context.routeThreadTs
          ? { routeThreadTs: context.routeThreadTs }
          : {}),
      },
      userInfoExtras:
        context.senderDisplayName || context.senderUserId
          ? {
              ...(context.senderDisplayName
                ? { slackDisplayName: context.senderDisplayName }
                : {}),
              ...(context.senderUserId
                ? { slackUserId: context.senderUserId }
                : {}),
            }
          : undefined,
    };
  },
);
