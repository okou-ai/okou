import { z } from "zod";
import { feishuChatIngress } from "@okouai/db/schema/feishu-chat-ingress";
import { isIntegrationDmSessionKey } from "../../lib/integration-dm-session";
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
import {
  type QueuedLaunchContextArgs,
  warnMissingQueuedLaunchEnrichment,
} from "./queued-launch-enrichment.service";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

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
    enrichmentMissing:
      row.conversationHistory === null ||
      row.messageText === null ||
      row.messageFiles === null,
    conversationHistory: row.conversationHistory ?? "",
    messageText: row.messageText ?? "",
    messageFiles: row.messageFiles ?? [],
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

const feishuIngressRoutingSchema = z.object({
  installationId: z.string(),
  tenantKey: z.string(),
  appId: z.string(),
  messageId: z.string(),
  chatId: z.string(),
  chatType: z.enum(["group", "p2p", "topic_group"]),
  rootId: z.string().nullable(),
  parentId: z.string().nullable(),
  threadId: z.string().nullable(),
  openId: z.string(),
});

function feishuIngressMatchesRoute(
  message: z.infer<typeof feishuIngressRoutingSchema>,
  route: {
    readonly installationId: string;
    readonly tenantKey: string | null;
    readonly appId: string;
    readonly senderOpenId: string;
    readonly chatId: string;
    readonly threadId: string;
  },
): boolean {
  const routeThreadId =
    message.chatType === "p2p" && message.threadId
      ? `thread:${message.threadId}`
      : (message.rootId ??
        message.threadId ??
        message.parentId ??
        message.messageId);
  const directSession =
    message.chatType === "p2p" &&
    !message.threadId &&
    isIntegrationDmSessionKey(route.threadId);
  return (
    message.installationId === route.installationId &&
    message.tenantKey === route.tenantKey &&
    message.appId === route.appId &&
    message.openId === route.senderOpenId &&
    message.chatId === route.chatId &&
    (directSession || routeThreadId === route.threadId)
  );
}

async function loadFeishuRouteLaunchMaterial(
  db: Db,
  args: QueuedLaunchContextArgs,
): Promise<FeishuQueuedLaunchMaterial | null> {
  const [route] = await db
    .select({
      chatId: feishuChatThreadRoutes.chatId,
      threadId: feishuChatThreadRoutes.threadId,
      connectionId: feishuOrgConnections.id,
      connectorSourceId: feishuOrgConnections.connectorId,
      senderOpenId: feishuOrgConnections.feishuOpenId,
      installationId: feishuOrgInstallations.id,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      platform: feishuOrgInstallations.platform,
      tenantKey: feishuOrgInstallations.feishuTenantKey,
      appId: feishuOrgInstallations.appId,
      publicBrand: feishuChatIngress.publicBrand,
      installationPublicBrand: feishuOrgInstallations.publicBrand,
      payload: feishuChatIngress.payload,
      reactionId: feishuChatIngress.reactionId,
    })
    .from(chatEvents)
    .innerJoin(
      feishuChatIngress,
      eq(feishuChatIngress.id, chatEvents.contextId),
    )
    .innerJoin(
      feishuOrgInstallations,
      and(
        eq(feishuOrgInstallations.id, feishuChatIngress.installationId),
        eq(feishuOrgInstallations.orgId, args.orgId),
      ),
    )
    .innerJoin(
      feishuOrgConnections,
      and(
        eq(feishuOrgConnections.installationId, feishuOrgInstallations.id),
        eq(feishuOrgConnections.userId, args.userId),
      ),
    )
    .innerJoin(
      feishuChatThreadRoutes,
      and(
        eq(feishuChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
        eq(feishuChatThreadRoutes.connectionId, feishuOrgConnections.id),
        eq(feishuChatThreadRoutes.userId, args.userId),
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
    !route?.connectorSourceId ||
    !route.senderOpenId ||
    !(await isFeishuInstallationEnabled(db, { ...route, orgId: args.orgId }))
  ) {
    return null;
  }
  const message = feishuIngressRoutingSchema.parse(
    JSON.parse(route.payload) as unknown,
  );
  if (
    !feishuIngressMatchesRoute(message, {
      ...route,
      senderOpenId: route.senderOpenId,
    })
  ) {
    return null;
  }
  warnMissingQueuedLaunchEnrichment("feishu", args);
  return {
    triggerSource: route.platform,
    prompt: args.userMessageProjection.agentPrompt,
    appendSystemPrompt: "",
    publicBrand: route.publicBrand ?? route.installationPublicBrand,
    connectorSourceId: route.connectorSourceId,
    feishuDelivery: {
      installationId: route.installationId,
      connectionId: route.connectionId,
      chatId: route.chatId,
      messageId: message.messageId,
      threadId: route.threadId,
      replyInThread: true,
      ...(route.reactionId ? { reactionId: route.reactionId } : {}),
    },
    userInfoExtras: { feishuOpenId: route.senderOpenId },
  };
}

export async function loadFeishuQueuedLaunchMaterial(
  db: Db,
  args: QueuedLaunchContextArgs,
): Promise<FeishuQueuedLaunchMaterial | null> {
  const context = await loadFeishuLaunchContext(db, args);
  if (!context) {
    return loadFeishuRouteLaunchMaterial(db, args);
  }
  if (context.enrichmentMissing) {
    warnMissingQueuedLaunchEnrichment("feishu", args);
  }
  return {
    triggerSource: context.platform,
    prompt: args.userMessageProjection.agentPrompt,
    appendSystemPrompt: context.enrichmentMissing
      ? ""
      : buildFeishuSystemPrompt({
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
            featureSwitchContext: args.featureSwitchContext,
          }),
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
