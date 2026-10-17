import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { and, eq } from "drizzle-orm";

import type { FeishuDeliveryTarget } from "./feishu-chat-callback-payload";
import { buildFeishuSystemPrompt } from "./feishu-dispatch.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

export interface FeishuQueuedLaunchMaterial {
  readonly triggerSource: FeishuPlatform;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly connectorSourceId: string;
  readonly feishuDelivery: FeishuDeliveryTarget;
  readonly userInfoExtras: {
    readonly feishuDisplayName?: string;
    readonly feishuOpenId: string;
  };
}

type FeishuLaunchContextRow = Pick<
  typeof chatFeishuContext.$inferSelect,
  | "conversationHistory"
  | "messageText"
  | "messageFiles"
  | "chatType"
  | "chatId"
  | "messageId"
  | "threadId"
  | "replyInThread"
  | "reactionId"
  | "senderOpenId"
  | "connectionId"
  | "installationId"
> & {
  readonly tenantKey: string | null;
  readonly platform: FeishuPlatform;
  readonly routeThreadId: string;
  readonly feishuDisplayName: string | null;
  readonly connectorSourceId: string | null;
};

export function requiredFeishuLaunchContext(
  row: FeishuLaunchContextRow | undefined,
) {
  if (
    !row ||
    row.conversationHistory === null ||
    row.messageText === null ||
    row.messageFiles === null ||
    row.chatType === null ||
    row.tenantKey === null ||
    row.chatId === null ||
    row.messageId === null ||
    row.threadId === null ||
    row.replyInThread === null ||
    row.senderOpenId === null ||
    row.connectionId === null ||
    row.connectorSourceId === null ||
    row.installationId === null
  ) {
    return null;
  }
  return {
    ...row,
    conversationHistory: row.conversationHistory,
    messageText: row.messageText,
    messageFiles: row.messageFiles,
    chatType: row.chatType,
    tenantKey: row.tenantKey,
    chatId: row.chatId,
    messageId: row.messageId,
    threadId: row.threadId,
    replyInThread: row.replyInThread,
    senderOpenId: row.senderOpenId,
    connectionId: row.connectionId,
    connectorSourceId: row.connectorSourceId,
    installationId: row.installationId,
  };
}

export function feishuQueuedLaunchContextReadPlan(args: {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
}) {
  return {
    columns: {
      conversationHistory: chatFeishuContext.conversationHistory,
      messageText: chatFeishuContext.messageText,
      messageFiles: chatFeishuContext.messageFiles,
      chatType: chatFeishuContext.chatType,
      tenantKey: feishuOrgInstallations.feishuTenantKey,
      platform: feishuOrgInstallations.platform,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      chatId: chatFeishuContext.chatId,
      messageId: chatFeishuContext.messageId,
      threadId: chatFeishuContext.threadId,
      replyInThread: chatFeishuContext.replyInThread,
      reactionId: chatFeishuContext.reactionId,
      senderOpenId: chatFeishuContext.senderOpenId,
      connectionId: chatFeishuContext.connectionId,
      connectorSourceId: feishuOrgConnections.connectorId,
      installationId: chatFeishuContext.installationId,
      routeThreadId: feishuChatThreadRoutes.threadId,
      feishuDisplayName: feishuOrgConnections.feishuUserName,
    },
    contextJoin: and(
      eq(chatFeishuContext.id, chatEvents.contextId),
      eq(chatFeishuContext.chatThreadId, chatEvents.chatThreadId),
    ),
    routeJoin: and(
      eq(feishuChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
      eq(feishuChatThreadRoutes.connectionId, chatFeishuContext.connectionId),
      eq(feishuChatThreadRoutes.chatId, chatFeishuContext.chatId),
      eq(feishuChatThreadRoutes.userId, args.userId),
    ),
    connectionJoin: and(
      eq(feishuOrgConnections.id, chatFeishuContext.connectionId),
      eq(feishuOrgConnections.installationId, chatFeishuContext.installationId),
      eq(feishuOrgConnections.userId, args.userId),
    ),
    installationJoin: and(
      eq(feishuOrgInstallations.id, chatFeishuContext.installationId),
      eq(feishuOrgInstallations.orgId, args.orgId),
    ),
    condition: and(
      eq(chatEvents.id, args.eventId),
      eq(chatEvents.chatThreadId, args.chatThreadId),
      eq(chatEvents.contextType, "feishu"),
    ),
  };
}

export function feishuQueuedLaunchMaterialFromContext(
  context: ReturnType<typeof requiredFeishuLaunchContext>,
  featureSwitchContext: FeatureSwitchContext,
): FeishuQueuedLaunchMaterial | null {
  if (!context) {
    return null;
  }
  return {
    triggerSource: context.platform,
    prompt: context.messageText,
    appendSystemPrompt: buildFeishuSystemPrompt({
      platform: context.platform,
      chatType: context.chatType,
      installationId: context.installationId,
      tenantKey: context.tenantKey,
      chatId: context.chatId,
      threadId: context.threadId,
      messageId: context.messageId,
      senderOpenId: context.senderOpenId,
      integrationNote: resolveIntegrationNotePrompt({
        triggerSource: context.platform,
        featureSwitchContext,
      }),
      history: context.conversationHistory,
    }),
    connectorSourceId: context.connectorSourceId,
    feishuDelivery: {
      installationId: context.installationId,
      connectionId: context.connectionId,
      chatId: context.chatId,
      messageId: context.messageId,
      threadId: context.routeThreadId,
      replyInThread: context.replyInThread,
      ...(context.reactionId ? { reactionId: context.reactionId } : {}),
      files: [...context.messageFiles],
    },
    userInfoExtras: {
      ...(context.feishuDisplayName
        ? { feishuDisplayName: context.feishuDisplayName }
        : {}),
      feishuOpenId: context.senderOpenId,
    },
  };
}
