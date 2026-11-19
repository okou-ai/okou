import type { FeishuPlatform } from "@okouai/core/feishu-platform";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { and, eq } from "drizzle-orm";
import { computed, type Computed } from "ccstate";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";

import { db$ } from "../external/db";
import {
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
  isFeishuInstallationFeatureEnabled,
} from "./feishu-config";

import type { FeishuDeliveryTarget } from "./feishu-chat-callback-payload";
import { buildFeishuSystemPrompt } from "./feishu-dispatch.service";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

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

interface FeishuLaunchSource {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly contextId?: string;
}

type FeishuLaunchInput =
  FeishuLaunchSource | Computed<Promise<FeishuLaunchSource | null>>;

export type FeishuThreadContext = ReturnType<
  typeof requiredFeishuLaunchContext
>;

function createFeishuStoredLaunchContext(source: FeishuLaunchInput) {
  return computed(async (get) => {
    const args = "eventId" in source ? source : await get(source);
    if (!args) {
      return undefined;
    }
    const [row] = await get(db$)
      .select({
        conversationHistory: chatFeishuContext.conversationHistory,
        messageText: chatFeishuContext.messageText,
        messageFiles: chatFeishuContext.messageFiles,
        chatType: chatFeishuContext.chatType,
        tenantKey: feishuOrgInstallations.feishuTenantKey,
        platform: feishuOrgInstallations.platform,
        installationType: feishuOrgInstallations.installationType,
        setupCompletedAt: feishuOrgInstallations.setupCompletedAt,
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
          eq(
            feishuChatThreadRoutes.connectionId,
            chatFeishuContext.connectionId,
          ),
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
          args.contextId === undefined
            ? undefined
            : eq(chatFeishuContext.id, args.contextId),
        ),
      )
      .limit(1);
    return row ? { row, args } : undefined;
  });
}

export function createFeishuRecoveryContext(args: FeishuLaunchSource) {
  const stored$ = createFeishuStoredLaunchContext(args);
  return computed(async (get): Promise<FeishuThreadContext> => {
    const stored = await get(stored$);
    return requiredFeishuLaunchContext(stored?.row);
  });
}

export function createFeishuLaunchContext(
  source: FeishuLaunchInput,
  actorFeatureSwitches$?: Computed<Promise<FeatureSwitchContext>>,
) {
  const stored$ = createFeishuStoredLaunchContext(source);
  return computed(async (get): Promise<FeishuThreadContext> => {
    const stored = await get(stored$);
    if (!stored) {
      return null;
    }
    const { row, args } = stored;
    const availability = feishuInstallationAvailabilityReadPlan({
      ...row,
      orgId: args.orgId,
    });
    if (availability.kind === "resolved") {
      return availability.enabled ? requiredFeishuLaunchContext(row) : null;
    }
    if (actorFeatureSwitches$ && availability.scope.userId === args.userId) {
      const enabled = isFeishuInstallationFeatureEnabled(
        availability.scope.installationType,
        await get(actorFeatureSwitches$),
      );
      return enabled ? requiredFeishuLaunchContext(row) : null;
    }
    const rows = await get(db$)
      .select(availability.columns)
      .from(userFeatureSwitches)
      .where(availability.condition);
    return feishuInstallationEnabledFromRows(availability.scope, rows)
      ? requiredFeishuLaunchContext(row)
      : null;
  });
}

export function feishuPromptFromContext(
  context: NonNullable<FeishuThreadContext>,
  featureSwitchContext: FeatureSwitchContext,
) {
  return {
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
  };
}

export function feishuDeliveryFromContext(
  context: NonNullable<FeishuThreadContext>,
): FeishuDeliveryTarget {
  return {
    installationId: context.installationId,
    connectionId: context.connectionId,
    chatId: context.chatId,
    messageId: context.messageId,
    threadId: context.routeThreadId,
    replyInThread: context.replyInThread,
    ...(context.reactionId ? { reactionId: context.reactionId } : {}),
    files: [...context.messageFiles],
  };
}
