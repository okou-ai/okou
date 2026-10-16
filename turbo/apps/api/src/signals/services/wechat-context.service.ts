import type { UserMessageDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { computed, command, type Computed } from "ccstate";
import { and, eq, desc, lt, sql } from "drizzle-orm";
import {
  chatWechatContext,
  wechatConnections,
  wechatChatThreadRoutes,
  wechatMessages,
} from "@okouai/db/schema/wechat";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { db$ } from "../external/db";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import { wechatEnabled$, createWechatMembership } from "./wechat-config";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { CONVERSATION_GUIDANCE } from "../../lib/conversation-guidance";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import type { WechatAttachments } from "@okouai/db/jsonb-contracts/wechat";
import { wechatConversationContext } from "../../lib/wechat-conversation-context";
import { resolveIntegrationNotePrompt } from "./integration-note-prompt.service";

interface Source {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
}
export class WechatLaunchUnavailableError extends Error {
  constructor() {
    super("This WeChat connection is no longer available.");
    this.name = "WechatLaunchUnavailableError";
  }
}
// The same owner, route and generation checks protect prompt and active-input reads.
function contextQuery(args: Source) {
  const columns = {
    id: chatWechatContext.id,
    chatThreadId: chatWechatContext.chatThreadId,
    connectionId: chatWechatContext.connectionId,
    generation: chatWechatContext.generation,
    senderId: chatWechatContext.senderId,
    botId: chatWechatContext.botId,
    messageId: chatWechatContext.messageId,
    quotedText: chatWechatContext.quotedText,
    createdAt: chatWechatContext.createdAt,
  };
  return new QueryBuilder()
    .select({
      ...columns,
      userMessage: canonicalChatEventUserMessage().as("user_message"),
    })
    .from(chatEvents)
    .innerJoin(
      chatWechatContext,
      and(
        eq(chatWechatContext.id, chatEvents.contextId),
        eq(chatWechatContext.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(
      wechatConnections,
      and(
        eq(wechatConnections.id, chatWechatContext.connectionId),
        eq(wechatConnections.generation, chatWechatContext.generation),
        eq(wechatConnections.senderId, chatWechatContext.senderId),
        eq(wechatConnections.botId, chatWechatContext.botId),
      ),
    )
    .innerJoin(
      wechatChatThreadRoutes,
      and(
        eq(wechatChatThreadRoutes.connectionId, wechatConnections.id),
        eq(wechatChatThreadRoutes.chatThreadId, chatEvents.chatThreadId),
      ),
    )
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
        eq(chatEvents.contextType, "wechat"),
        eq(chatThreads.userId, args.userId),
        eq(agents.orgId, args.orgId),
        eq(wechatConnections.userId, args.userId),
        eq(wechatConnections.orgId, args.orgId),
        eq(wechatConnections.status, "active"),
      ),
    )
    .limit(1);
}
function recentMessagesQuery(connectionId: string, id: string) {
  return new QueryBuilder()
    .select({
      id: wechatMessages.id,
      direction: wechatMessages.direction,
      status: wechatMessages.status,
      content: wechatMessages.content,
      attachments: wechatMessages.attachments,
    })
    .from(wechatMessages)
    .where(
      and(
        eq(wechatMessages.connectionId, connectionId),
        lt(
          wechatMessages.sequence,
          sql`(SELECT sequence FROM wechat_messages WHERE id=${id}::uuid AND connection_id=${connectionId}::uuid)`,
        ),
      ),
    )
    .orderBy(desc(wechatMessages.sequence))
    .limit(20);
}
// Drizzle's typed query is executed by the owning signal; no database capability
// is passed through service arguments.
function launchMaterial(
  row:
    | (Omit<typeof chatWechatContext.$inferSelect, "contextTokenCiphertext"> & {
        userMessage: UserMessageDocument | null;
      })
    | undefined,
  history: readonly {
    id: string;
    direction: string;
    status: string;
    content: string;
    attachments: WechatAttachments;
  }[],
) {
  if (!row) {
    return null;
  }
  const message = requiredUserMessageForEvent("input.prompt", row.userMessage);
  if (!message) {
    throw new Error("WeChat input is missing its canonical message");
  }
  return {
    prompt: projectUserMessage(message).agentPrompt,
    appendSystemPrompt: [
      CONVERSATION_GUIDANCE,
      "# Current Integration\nYou are currently running inside: WeChat",
      `Conversation: direct message\nChannel ID: ${row.connectionId}\nStored message ID: ${row.id}\nSender ID: ${row.senderId}\nBot ID: ${row.botId}\nMessage ID: ${row.messageId}`,
      resolveIntegrationNotePrompt({
        triggerSource: "wechat",
        featureSwitchContext: {},
      }),
      wechatConversationContext({
        connectionId: row.connectionId,
        senderId: row.senderId,
        botId: row.botId,
        messages: [...history].reverse(),
      }),
      ...(row.quotedText
        ? [`# Quoted message (untrusted)\n${row.quotedText}`]
        : []),
    ].join("\n\n"),
    wechatDelivery: {
      connectionId: row.connectionId,
      generation: row.generation,
      contextId: row.id,
      senderId: row.senderId,
      messageId: row.messageId,
    },
  };
}
export function createWechatThreadContext(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  orgId: string,
  featureSwitches$: Computed<Promise<FeatureSwitchContext>>,
) {
  const identity$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    return event?.contextType === "wechat"
      ? { orgId, userId: event.userId }
      : null;
  });
  const membership$ = createWechatMembership(identity$);
  return computed(async (get) => {
    if (!(await get(membership$))) {
      return null;
    }
    const event = await get(pickedEvent$);
    if (
      event?.contextType !== "wechat" ||
      !isFeatureEnabled(
        FeatureSwitchKey.WechatIntegration,
        await get(featureSwitches$),
      )
    ) {
      return null;
    }
    const rows = await get(db$)
      .select()
      .from(
        contextQuery({
          eventId: event.id,
          chatThreadId: event.chatThreadId,
          orgId,
          userId: event.userId,
        }).as("wechat_context"),
      );
    const row = rows[0];
    const history = row
      ? await get(db$)
          .select()
          .from(
            recentMessagesQuery(row.connectionId, row.id).as("wechat_recent"),
          )
      : [];
    return launchMaterial(row, history);
  });
}
export const loadWechatQueuedLaunchMaterial$ = command(
  async ({ get, set }, args: Source, signal: AbortSignal) => {
    if (!(await set(wechatEnabled$, args.orgId, args.userId, signal))) {
      return null;
    }
    const rows = await get(db$)
      .select()
      .from(contextQuery(args).as("wechat_context"));
    signal.throwIfAborted();
    const row = rows[0];
    const history = row
      ? await get(db$)
          .select()
          .from(
            recentMessagesQuery(row.connectionId, row.id).as("wechat_recent"),
          )
      : [];
    signal.throwIfAborted();
    return launchMaterial(row, history);
  },
);
