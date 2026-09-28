import { agentphoneChatThreadRoutes } from "@okouai/db/schema/agentphone-chat-thread-route";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { and, eq, isNotNull } from "drizzle-orm";

import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import type { Db } from "../external/db";

/** Main integration DMs keep following the member's current model preference. */
export async function isIntegrationDirectMessageThread(
  db: Pick<Db, "select">,
  threadId: string,
): Promise<boolean> {
  const routes = await db
    .select({ id: slackChatThreadRoutes.chatThreadId })
    .from(slackChatThreadRoutes)
    .where(
      and(
        eq(slackChatThreadRoutes.chatThreadId, threadId),
        eq(slackChatThreadRoutes.threadTs, INTEGRATION_DM_SESSION_KEY),
      ),
    )
    .unionAll(
      db
        .select({ id: feishuChatThreadRoutes.chatThreadId })
        .from(feishuChatThreadRoutes)
        .where(
          and(
            eq(feishuChatThreadRoutes.chatThreadId, threadId),
            eq(feishuChatThreadRoutes.threadId, INTEGRATION_DM_SESSION_KEY),
          ),
        ),
    )
    .unionAll(
      db
        .select({ id: teamsChatThreadRoutes.chatThreadId })
        .from(teamsChatThreadRoutes)
        .where(
          and(
            eq(teamsChatThreadRoutes.chatThreadId, threadId),
            eq(teamsChatThreadRoutes.threadId, INTEGRATION_DM_SESSION_KEY),
          ),
        ),
    )
    .unionAll(
      db
        .select({ id: discordChatThreadRoutes.chatThreadId })
        .from(discordChatThreadRoutes)
        .where(
          and(
            eq(discordChatThreadRoutes.chatThreadId, threadId),
            eq(discordChatThreadRoutes.sessionKey, INTEGRATION_DM_SESSION_KEY),
          ),
        ),
    )
    .unionAll(
      db
        .select({ id: telegramChatThreadRoutes.chatThreadId })
        .from(telegramChatThreadRoutes)
        .where(
          and(
            eq(telegramChatThreadRoutes.chatThreadId, threadId),
            eq(
              telegramChatThreadRoutes.rootMessageId,
              INTEGRATION_DM_SESSION_KEY,
            ),
            isNotNull(telegramChatThreadRoutes.telegramOfficialUserLinkId),
          ),
        ),
    )
    .unionAll(
      db
        .select({ id: agentphoneChatThreadRoutes.chatThreadId })
        .from(agentphoneChatThreadRoutes)
        .where(
          and(
            eq(agentphoneChatThreadRoutes.chatThreadId, threadId),
            eq(
              agentphoneChatThreadRoutes.rootMessageId,
              INTEGRATION_DM_SESSION_KEY,
            ),
          ),
        ),
    )
    .limit(1);
  return routes.length > 0;
}
