import { isFeishuInstallationEnabled } from "./feishu-config";
import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import type { FeishuDeliveryTarget } from "./feishu-chat-callback-payload";
import { buildFeishuSystemPrompt } from "./feishu-dispatch.service";

export interface FeishuQueuedLaunchMaterial {
  readonly triggerSource: FeishuPlatform;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly publicBrand: PublicBrand;
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
  | "publicBrand"
> & {
  readonly tenantKey: string | null;
  readonly platform: FeishuPlatform;
  readonly routeThreadId: string;
  readonly feishuDisplayName: string | null;
  readonly connectorSourceId: string | null;
};

function requiredFeishuLaunchContext(row: FeishuLaunchContextRow | undefined) {
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
    row.installationId === null ||
    row.publicBrand === null
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
    publicBrand: row.publicBrand,
  };
}

async function loadFeishuLaunchContext(
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
      publicBrand: chatFeishuContext.publicBrand,
    })
    .from(chatEvents)
    .innerJoin(
      chatFeishuContext,
      and(
        eq(chatFeishuContext.id, chatEvents.contextId),
        eq(chatFeishuContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      feishuChatThreadRoutes,
      and(
        eq(feishuChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(feishuChatThreadRoutes.connectionId, chatFeishuContext.connectionId),
        eq(feishuChatThreadRoutes.chatId, chatFeishuContext.chatId),
        eq(feishuChatThreadRoutes.userId, args.userId),
      ),
    )
    .innerJoin(
      feishuOrgConnections,
      and(
        eq(feishuOrgConnections.id, chatFeishuContext.connectionId),
        eq(
          feishuOrgConnections.installationId,
          chatFeishuContext.installationId,
        ),
        eq(feishuOrgConnections.userId, args.userId),
      ),
    )
    .innerJoin(
      feishuOrgInstallations,
      and(
        eq(feishuOrgInstallations.id, chatFeishuContext.installationId),
        eq(feishuOrgInstallations.orgId, args.orgId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "feishu"),
      ),
    )
    .limit(1);
  if (
    row &&
    !(await isFeishuInstallationEnabled(db, { ...row, orgId: args.orgId }))
  ) {
    return null;
  }
  return requiredFeishuLaunchContext(row);
}

export async function loadFeishuQueuedLaunchMaterial(
  db: Db,
  args: {
    readonly eventId: string;
    readonly chatThreadId: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<FeishuQueuedLaunchMaterial | null> {
  const context = await loadFeishuLaunchContext(db, args);
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
      history: context.conversationHistory,
    }),
    publicBrand: context.publicBrand,
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
