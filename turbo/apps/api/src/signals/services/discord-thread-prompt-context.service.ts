import { computed, type Computed } from "ccstate";
import { and, eq, exists, sql } from "drizzle-orm";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import { discordUserBindingReadPlan } from "./discord-data.service";
import { createDiscordPromptAccess } from "./discord-access.service";
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

function createDiscordLaunchRow(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  orgId: string,
) {
  return computed(async (get) => {
    const event = await get(pickedEvent$);
    if (event?.contextType !== "discord") {
      return null;
    }
    const db = get(db$);
    const bindingPlan = discordUserBindingReadPlan({
      orgId,
      userId: event.userId,
    });
    const threadRoute = db
      .select({ id: discordChatThreadRoutes.id })
      .from(discordChatThreadRoutes)
      .where(eq(discordChatThreadRoutes.chatThreadId, event.chatThreadId));
    const [snapshot] = await db
      .select({
        context: {
          connectionId: chatDiscordContext.connectionId,
          routeId: chatDiscordContext.routeId,
          guildId: chatDiscordContext.guildId,
          discordUserId: chatDiscordContext.senderUserId,
          botUserId: chatDiscordContext.botUserId,
          channelId: chatDiscordContext.destinationChannelId,
          sourceChannelId: chatDiscordContext.channelId,
          messageId: chatDiscordContext.messageId,
          conversationContext: chatDiscordContext.conversationContext,
        },
        route: {
          chatThreadId: discordChatThreadRoutes.chatThreadId,
          connectionId: discordChatThreadRoutes.connectionId,
          userId: discordChatThreadRoutes.userId,
          channelId: discordChatThreadRoutes.channelId,
          destinationChannelId: discordChatThreadRoutes.destinationChannelId,
          sessionKey: discordChatThreadRoutes.sessionKey,
        },
        connected: discordOrgConnections.id,
        binding: bindingPlan.columns,
        threadHasRoute: sql`CASE
          WHEN ${chatDiscordContext.id} IS NULL OR ${discordChatThreadRoutes.id} IS NULL OR ${discordOrgConnections.id} IS NULL
          THEN ${exists(threadRoute)}
          ELSE FALSE
        END`.mapWith(pgBooleanDecoder),
      })
      .from(sql`(SELECT 1) AS discord_launch`)
      .leftJoin(
        chatDiscordContext,
        and(
          event.contextId
            ? eq(chatDiscordContext.id, event.contextId)
            : sql`false`,
          eq(chatDiscordContext.chatThreadId, event.chatThreadId),
        ),
      )
      .leftJoin(
        discordChatThreadRoutes,
        eq(discordChatThreadRoutes.id, chatDiscordContext.routeId),
      )
      .leftJoin(
        discordOrgConnections,
        eq(discordOrgConnections.id, chatDiscordContext.connectionId),
      )
      .leftJoin(
        bindingPlan.join,
        and(bindingPlan.joinCondition, bindingPlan.where),
      );
    return { event, snapshot };
  });
}

function createDiscordLaunchSnapshot(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  orgId: string,
) {
  const row$ = createDiscordLaunchRow(pickedEvent$, orgId);
  return computed(async (get) => {
    const launch = await get(row$);
    if (!launch) {
      return null;
    }
    const { event, snapshot } = launch;
    if (!snapshot?.context || !snapshot.route || !snapshot.connected) {
      if (snapshot?.threadHasRoute) {
        throw new Error("Discord queue item is missing its owned context");
      }
      return null;
    }
    const { context, route, binding } = snapshot;
    const target = discordDeliveryTargetSchema.parse({
      ...context,
      sessionKey: route.sessionKey,
    });
    if (
      route.chatThreadId !== event.chatThreadId ||
      route.connectionId !== target.connectionId ||
      route.userId !== event.userId ||
      (route.destinationChannelId ?? route.sessionKey) !== target.channelId
    ) {
      return null;
    }
    return {
      target,
      botUserId: context.botUserId,
      conversationContext: context.conversationContext,
      accessInput: {
        orgId,
        userId: event.userId,
        guildId: target.guildId ?? undefined,
        connectionId: target.connectionId,
        discordUserId: target.discordUserId,
        sourceChannelId: context.sourceChannelId,
        destinationChannelId: route.destinationChannelId ?? route.channelId,
        hasConversationContext: context.conversationContext !== null,
        binding:
          binding?.orgId === orgId &&
          binding.userId === event.userId &&
          binding.discordUserId === target.discordUserId
            ? {
                ...binding,
                orgId,
                userId: event.userId,
                discordUserId: target.discordUserId,
                connectionId: target.connectionId,
              }
            : null,
      },
    };
  });
}

export function createDiscordThreadContext(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  orgId: string,
  timing$: Computed<ApiDispatchTimingCollector>,
) {
  const snapshot$ = createDiscordLaunchSnapshot(pickedEvent$, orgId);
  const identity$ = computed(async (get) => {
    const event = await get(pickedEvent$);
    return event?.contextType === "discord"
      ? { orgId, userId: event.userId }
      : null;
  });
  const accessInput$ = computed(async (get) => {
    return (await get(snapshot$))?.accessInput ?? null;
  });
  const authorization = createDiscordPromptAccess(
    accessInput$,
    identity$,
    timing$,
  );
  const context$ = computed(
    async (get): Promise<DiscordThreadContext | null> => {
      const [snapshot, access] = await Promise.all([
        get(snapshot$),
        get(authorization.access$),
      ]);
      if (!snapshot || !access) {
        return null;
      }
      return {
        target: snapshot.target,
        botUserId: snapshot.botUserId,
        conversationContext: snapshot.conversationContext,
        conversationContextAllowed: access.conversationContextAllowed,
        messageContentEnabled: access.messageContentEnabled,
      };
    },
  );
  const resources$ = computed(async (get) => {
    // The pick owns membership work even when local context is unavailable.
    await Promise.allSettled([
      get(context$),
      get(authorization.membershipLookup$).membership,
    ]);
  });
  return { context$, resources$ };
}
