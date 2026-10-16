import { computed, type Computed } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { db$ } from "../external/db";
import { discordPromptAccess } from "./discord-access.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  discordDeliveryTargetSchema,
  type DiscordDeliveryTarget,
} from "./discord-chat-callback-payload";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

interface DiscordThreadContext {
  readonly target: DiscordDeliveryTarget;
  readonly botUserId: string;
  readonly conversationContext: string | null;
  readonly conversationContextAllowed: boolean;
  readonly messageContentEnabled: boolean;
}

function createDiscordStoredContext(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
) {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (pickedEvent?.contextType !== "discord" || !pickedEvent.contextId) {
      return null;
    }
    const [context] = await get(db$)
      .select({
        connectionId: chatDiscordContext.connectionId,
        routeId: chatDiscordContext.routeId,
        guildId: chatDiscordContext.guildId,
        discordUserId: chatDiscordContext.senderUserId,
        botUserId: chatDiscordContext.botUserId,
        channelId: chatDiscordContext.destinationChannelId,
        routeChannelId: discordChatThreadRoutes.channelId,
        destinationChannelId: discordChatThreadRoutes.destinationChannelId,
        sourceChannelId: chatDiscordContext.channelId,
        messageId: chatDiscordContext.messageId,
        sessionKey: discordChatThreadRoutes.sessionKey,
        conversationContext: chatDiscordContext.conversationContext,
      })
      .from(chatDiscordContext)
      .innerJoin(
        discordChatThreadRoutes,
        eq(discordChatThreadRoutes.id, chatDiscordContext.routeId),
      )
      .innerJoin(
        discordOrgConnections,
        eq(discordOrgConnections.id, chatDiscordContext.connectionId),
      )
      .where(
        and(
          eq(chatDiscordContext.id, pickedEvent.contextId),
          eq(chatDiscordContext.chatThreadId, pickedEvent.chatThreadId),
        ),
      )
      .limit(1);
    return context ?? null;
  });
}

function createDiscordThreadTarget(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  context$: ReturnType<typeof createDiscordStoredContext>,
) {
  return computed(async (get) => {
    const [pickedEvent, context] = await Promise.all([
      get(pickedEvent$),
      get(context$),
    ]);
    if (pickedEvent?.contextType !== "discord") {
      return null;
    }
    const db = get(db$);
    if (!context) {
      const [route] = await db
        .select({ id: discordChatThreadRoutes.id })
        .from(discordChatThreadRoutes)
        .where(
          eq(discordChatThreadRoutes.chatThreadId, pickedEvent.chatThreadId),
        )
        .limit(1);
      if (route) {
        throw new Error("Discord queue item is missing its owned context");
      }
      return null;
    }
    const target = discordDeliveryTargetSchema.parse(context);
    const [route] = await db
      .select({ id: discordChatThreadRoutes.id })
      .from(discordChatThreadRoutes)
      .where(
        and(
          eq(discordChatThreadRoutes.chatThreadId, pickedEvent.chatThreadId),
          eq(discordChatThreadRoutes.connectionId, target.connectionId),
          eq(discordChatThreadRoutes.id, target.routeId),
          or(
            eq(discordChatThreadRoutes.destinationChannelId, target.channelId),
            and(
              isNull(discordChatThreadRoutes.destinationChannelId),
              eq(discordChatThreadRoutes.sessionKey, target.channelId),
            ),
          ),
          eq(discordChatThreadRoutes.sessionKey, target.sessionKey),
          eq(discordChatThreadRoutes.userId, pickedEvent.userId),
        ),
      )
      .limit(1);
    return route ? target : null;
  });
}

export function createDiscordThreadContext(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  orgId: string,
  timing$: Computed<ApiDispatchTimingCollector>,
): Computed<Promise<DiscordThreadContext | null>> {
  const context$ = createDiscordStoredContext(pickedEvent$);
  const target$ = createDiscordThreadTarget(pickedEvent$, context$);
  const accessInput$ = computed(async (get) => {
    const [pickedEvent, context, target] = await Promise.all([
      get(pickedEvent$),
      get(context$),
      get(target$),
    ]);
    return pickedEvent && context && target
      ? {
          orgId,
          userId: pickedEvent.userId,
          guildId: target.guildId ?? undefined,
          connectionId: target.connectionId,
          discordUserId: target.discordUserId,
          sourceChannelId: context.sourceChannelId,
          destinationChannelId:
            context.destinationChannelId ?? context.routeChannelId,
          hasConversationContext: context.conversationContext !== null,
        }
      : null;
  });
  const access$ = discordPromptAccess(accessInput$, timing$);
  return computed(async (get) => {
    const [context, target, access] = await Promise.all([
      get(context$),
      get(target$),
      get(access$),
    ]);
    if (!context || !target || !access) {
      return null;
    }
    return {
      target,
      botUserId: context.botUserId,
      conversationContext: context.conversationContext,
      conversationContextAllowed: access.conversationContextAllowed,
      messageContentEnabled: access.messageContentEnabled,
    };
  });
}
