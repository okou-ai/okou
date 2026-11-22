import { command } from "ccstate";
import { and, eq, or } from "drizzle-orm";
import { uuid } from "zod";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { slackOrgConnections } from "@okouai/db/schema/slack-org-connection";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { db$ } from "../external/db";

type RecoveryActor = {
  readonly eventId: string;
  readonly platformUserId: string;
  readonly conversationId: string;
} & (
  | { readonly channel: "slack"; readonly workspaceId: string }
  | {
      readonly channel: "teams";
      readonly workspaceId: string;
      readonly aadObjectId?: string;
    }
  | { readonly channel: "discord" | "telegram" }
  | { readonly channel: "feishu"; readonly installationId: string }
);

interface RecoveryThreadOwner {
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
}

function slackRecoveryCondition(
  event: RecoveryThreadOwner,
  actor: Extract<RecoveryActor, { channel: "slack" }>,
) {
  return and(
    eq(slackChatThreadRoutes.chatThreadId, event.threadId),
    eq(slackChatThreadRoutes.channelId, actor.conversationId),
    eq(slackChatThreadRoutes.userId, event.userId),
    eq(slackOrgConnections.userId, event.userId),
    eq(slackOrgConnections.slackUserId, actor.platformUserId),
    eq(slackOrgConnections.slackWorkspaceId, actor.workspaceId),
  );
}

function discordRecoveryCondition(
  event: RecoveryThreadOwner,
  actor: RecoveryActor,
) {
  return and(
    eq(discordChatThreadRoutes.chatThreadId, event.threadId),
    eq(discordChatThreadRoutes.userId, event.userId),
    eq(discordOrgConnections.userId, event.userId),
    eq(discordOrgConnections.orgId, event.orgId),
    eq(discordOrgConnections.discordUserId, actor.platformUserId),
    or(
      eq(discordChatThreadRoutes.destinationChannelId, actor.conversationId),
      eq(discordChatThreadRoutes.channelId, actor.conversationId),
    ),
  );
}

function feishuRecoveryCondition(
  event: RecoveryThreadOwner,
  actor: Extract<RecoveryActor, { channel: "feishu" }>,
) {
  return and(
    eq(feishuChatThreadRoutes.chatThreadId, event.threadId),
    eq(feishuChatThreadRoutes.chatId, actor.conversationId),
    eq(feishuChatThreadRoutes.userId, event.userId),
    eq(feishuOrgConnections.userId, event.userId),
    eq(feishuOrgConnections.installationId, actor.installationId),
    eq(feishuOrgConnections.feishuOpenId, actor.platformUserId),
  );
}

/** Called only after the integration's signature/authorization is verified. */
export const integrationModelRecoveryIdentity$ = command(
  async ({ get }, actor: RecoveryActor, signal: AbortSignal) => {
    if (!uuid().safeParse(actor.eventId).success) {
      return null;
    }
    const db = get(db$);
    const [event] = await db
      .select({
        eventId: chatEvents.id,
        threadId: chatThreads.id,
        userId: chatThreads.userId,
        orgId: chatThreads.orgId,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .where(eq(chatEvents.id, actor.eventId))
      .limit(1);
    signal.throwIfAborted();
    if (!event) {
      return null;
    }
    let allowed: boolean;
    switch (actor.channel) {
      case "slack": {
        const [route] = await db
          .select({ id: slackChatThreadRoutes.id })
          .from(slackChatThreadRoutes)
          .innerJoin(
            slackOrgConnections,
            eq(slackOrgConnections.id, slackChatThreadRoutes.connectionId),
          )
          .where(slackRecoveryCondition(event, actor))
          .limit(1);
        signal.throwIfAborted();
        allowed = route !== undefined;
        break;
      }
      case "discord": {
        const [route] = await db
          .select({ id: discordChatThreadRoutes.id })
          .from(discordChatThreadRoutes)
          .innerJoin(
            discordOrgConnections,
            eq(discordOrgConnections.id, discordChatThreadRoutes.connectionId),
          )
          .where(discordRecoveryCondition(event, actor))
          .limit(1);
        signal.throwIfAborted();
        allowed = route !== undefined;
        break;
      }
      case "feishu": {
        const [route] = await db
          .select({ id: feishuChatThreadRoutes.id })
          .from(feishuChatThreadRoutes)
          .innerJoin(
            feishuOrgConnections,
            eq(feishuOrgConnections.id, feishuChatThreadRoutes.connectionId),
          )
          .where(feishuRecoveryCondition(event, actor))
          .limit(1);
        signal.throwIfAborted();
        allowed = route !== undefined;
        break;
      }
      case "teams": {
        const [route] = await db
          .select({ id: teamsChatThreadRoutes.id })
          .from(teamsChatThreadRoutes)
          .innerJoin(
            teamsOrgConnections,
            eq(teamsOrgConnections.id, teamsChatThreadRoutes.connectionId),
          )
          .where(
            and(
              eq(teamsChatThreadRoutes.chatThreadId, event.threadId),
              eq(teamsChatThreadRoutes.conversationId, actor.conversationId),
              eq(teamsChatThreadRoutes.userId, event.userId),
              eq(teamsOrgConnections.userId, event.userId),
              eq(teamsOrgConnections.orgId, event.orgId),
              eq(teamsOrgConnections.teamsTenantId, actor.workspaceId),
              or(
                eq(teamsOrgConnections.teamsUserId, actor.platformUserId),
                actor.aadObjectId
                  ? eq(teamsOrgConnections.teamsAadObjectId, actor.aadObjectId)
                  : undefined,
              ),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        allowed = route !== undefined;
        break;
      }
      case "telegram": {
        const [route] = await db
          .select({ id: telegramChatThreadRoutes.id })
          .from(telegramChatThreadRoutes)
          .innerJoin(
            telegramOfficialUserLinks,
            eq(
              telegramOfficialUserLinks.id,
              telegramChatThreadRoutes.telegramOfficialUserLinkId,
            ),
          )
          .where(
            and(
              eq(telegramChatThreadRoutes.chatThreadId, event.threadId),
              eq(telegramChatThreadRoutes.chatId, actor.conversationId),
              eq(telegramOfficialUserLinks.userId, event.userId),
              eq(telegramOfficialUserLinks.orgId, event.orgId),
              eq(
                telegramOfficialUserLinks.telegramUserId,
                actor.platformUserId,
              ),
            ),
          )
          .limit(1);
        signal.throwIfAborted();
        allowed = route !== undefined;
      }
    }
    signal.throwIfAborted();
    return allowed
      ? { eventId: event.eventId, orgId: event.orgId, userId: event.userId }
      : null;
  },
);
