import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { githubChatThreadRoutes } from "@okouai/db/schema/github-chat-thread-route";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { and, eq } from "drizzle-orm";
import type { Db } from "../external/db";
import type { NewDisplayContext } from "./chat-event.service";

/** Prepare stable delivery identity before optional enrichment is written. */
export async function persistChatEventDeliveryRouting(
  db: Pick<Db, "update">,
  context: NewDisplayContext,
): Promise<void> {
  if (context.type === "telegram") {
    await db
      .update(telegramChatThreadRoutes)
      .set({
        messageThreadId: context.messageThreadId,
        chatType: context.chatType,
        deliveryMessageId: context.messageId,
      })
      .where(
        and(
          eq(telegramChatThreadRoutes.chatThreadId, context.chatThreadId),
          eq(telegramChatThreadRoutes.chatId, context.chatId),
          context.userLinkKind === "custom"
            ? eq(
                telegramChatThreadRoutes.telegramUserLinkId,
                context.userLinkId,
              )
            : eq(
                telegramChatThreadRoutes.telegramOfficialUserLinkId,
                context.userLinkId,
              ),
        ),
      );
  } else if (context.type === "agentphone") {
    await db
      .update(agentphoneChatThreadRoutes)
      .set({
        isGroup: context.isGroup,
        groupId: context.groupId,
        channel: context.channel,
        fromNumber: context.fromNumber,
        toNumber: context.toNumber,
        agentphoneAgentId: context.agentphoneAgentId,
        deliveryMessageId: context.messageId,
      })
      .where(
        and(
          eq(agentphoneChatThreadRoutes.chatThreadId, context.chatThreadId),
          eq(
            agentphoneChatThreadRoutes.agentphoneUserLinkId,
            context.userLinkId,
          ),
        ),
      );
  } else if (context.type === "teams") {
    await db
      .update(teamsChatThreadRoutes)
      .set({
        conversationType: context.conversationType,
        channelId: context.channelId,
        serviceUrl: context.serviceUrl,
      })
      .where(
        and(
          eq(teamsChatThreadRoutes.chatThreadId, context.chatThreadId),
          eq(teamsChatThreadRoutes.connectionId, context.connectionId),
          eq(teamsChatThreadRoutes.conversationId, context.conversationId),
          eq(teamsChatThreadRoutes.threadId, context.threadId),
        ),
      );
  } else if (context.type === "github") {
    await db
      .update(githubChatThreadRoutes)
      .set({
        subjectKind: context.subjectKind,
      })
      .where(
        and(
          eq(githubChatThreadRoutes.chatThreadId, context.chatThreadId),
          eq(githubChatThreadRoutes.repo, context.repo),
          eq(githubChatThreadRoutes.subjectNumber, context.subjectNumber),
        ),
      );
  }
}
