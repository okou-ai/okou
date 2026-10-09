import { computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { discordOrgConnections } from "@okouai/db/schema/discord-org-connection";
import { db$ } from "../external/db";
import {
  discordConversationAccess,
  type DiscordConversationAccess,
} from "./discord-access.service";
import {
  discordDeliveryTargetSchema,
  type DiscordDeliveryTarget,
} from "./discord-chat-callback-payload";
import type { ThreadPromptSource } from "./thread-run-prompt/types";

interface DiscordThreadContext {
  readonly target: DiscordDeliveryTarget;
  readonly botUserId: string;
  readonly conversationContext: string | null;
  readonly conversationContextAllowed: boolean;
  readonly messageContentEnabled: boolean;
}

function checkedAccess(
  access: DiscordConversationAccess | null,
  target: DiscordDeliveryTarget,
) {
  if (!access) {
    return null;
  }
  if (access.kind === "denied") {
    if (access.response.status === 403 || access.response.status === 404) {
      return null;
    }
    throw new Error(`Discord access check failed: ${access.response.status}`);
  }
  return access.binding.connectionId === target.connectionId &&
    access.binding.discordUserId === target.discordUserId
    ? access
    : null;
}

function createDiscordStoredContext(
  source$: Computed<Promise<ThreadPromptSource | null>>,
) {
  return computed(async (get) => {
    const source = await get(source$);
    if (source?.event.contextType !== "discord" || !source.event.contextId) {
      return null;
    }
    const [context] = await get(db$)
      .select({
        connectionId: chatDiscordContext.connectionId,
        routeId: chatDiscordContext.routeId,
        guildId: discordOrgConnections.guildId,
        discordUserId: chatDiscordContext.senderUserId,
        botUserId: chatDiscordContext.botUserId,
        channelId: chatDiscordContext.destinationChannelId,
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
          eq(chatDiscordContext.id, source.event.contextId),
          eq(chatDiscordContext.chatThreadId, source.chatThreadId),
        ),
      )
      .limit(1);
    return context ?? null;
  });
}

function createDiscordThreadTarget(
  source$: Computed<Promise<ThreadPromptSource | null>>,
  context$: ReturnType<typeof createDiscordStoredContext>,
) {
  return computed(async (get) => {
    const [source, context] = await Promise.all([get(source$), get(context$)]);
    if (source?.event.contextType !== "discord") {
      return null;
    }
    const db = get(db$);
    if (!context) {
      const [route] = await db
        .select({ id: discordChatThreadRoutes.id })
        .from(discordChatThreadRoutes)
        .where(eq(discordChatThreadRoutes.chatThreadId, source.chatThreadId))
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
          eq(discordChatThreadRoutes.chatThreadId, source.chatThreadId),
          eq(discordChatThreadRoutes.connectionId, target.connectionId),
          eq(discordChatThreadRoutes.id, target.routeId),
          eq(discordChatThreadRoutes.destinationChannelId, target.channelId),
          eq(discordChatThreadRoutes.sessionKey, target.sessionKey),
          eq(discordChatThreadRoutes.userId, source.event.userId),
        ),
      )
      .limit(1);
    return route ? target : null;
  });
}

export function createDiscordThreadContext(
  source$: Computed<Promise<ThreadPromptSource | null>>,
): Computed<Promise<DiscordThreadContext | null>> {
  const context$ = createDiscordStoredContext(source$);
  const target$ = createDiscordThreadTarget(source$, context$);
  const sourceAccessInput$ = computed(async (get) => {
    const [source, context, target] = await Promise.all([
      get(source$),
      get(context$),
      get(target$),
    ]);
    return source && context && target
      ? {
          orgId: source.orgId,
          userId: source.event.userId,
          guildId: target.guildId,
          channelId: context.sourceChannelId,
          mode: "view" as const,
        }
      : null;
  });
  const sourceAccess$ = discordConversationAccess(sourceAccessInput$);
  const historyAccessInput$ = computed(async (get) => {
    const [input, context, target] = await Promise.all([
      get(sourceAccessInput$),
      get(context$),
      get(target$),
    ]);
    if (!input || !context || !target) {
      return null;
    }
    const sourceAccess = checkedAccess(await get(sourceAccess$), target);
    return sourceAccess &&
      sourceAccess.channel.type !== 1 &&
      sourceAccess.messageContentEnabled &&
      context.conversationContext !== null
      ? { ...input, mode: "read" as const }
      : null;
  });
  const historyAccess$ = discordConversationAccess(historyAccessInput$);
  const conversationAccess$ = computed(async (get) => {
    const [context, target] = await Promise.all([get(context$), get(target$)]);
    if (!context || !target) {
      return null;
    }
    const sourceAccess = checkedAccess(await get(sourceAccess$), target);
    if (!sourceAccess) {
      return null;
    }
    // DM history is shared across orgs and must never reach a run.
    let messageContentEnabled = sourceAccess.messageContentEnabled;
    let conversationContextAllowed =
      sourceAccess.channel.type !== 1 && messageContentEnabled;
    if (context.conversationContext !== null && conversationContextAllowed) {
      const historyAccess = checkedAccess(await get(historyAccess$), target);
      if (historyAccess) {
        messageContentEnabled = historyAccess.messageContentEnabled;
      }
      conversationContextAllowed =
        historyAccess !== null && messageContentEnabled;
    }
    return { conversationContextAllowed, messageContentEnabled };
  });
  const destinationAccessInput$ = computed(async (get) => {
    const conversation = await get(conversationAccess$);
    if (!conversation) {
      return null;
    }
    const [input, target] = await Promise.all([
      get(sourceAccessInput$),
      get(target$),
    ]);
    return input && target
      ? {
          ...input,
          channelId: target.channelId,
          mode: "write" as const,
        }
      : null;
  });
  const destinationAccess$ = discordConversationAccess(destinationAccessInput$);
  return computed(async (get) => {
    const [context, target, conversation] = await Promise.all([
      get(context$),
      get(target$),
      get(conversationAccess$),
    ]);
    if (!context || !target || !conversation) {
      return null;
    }
    // Reading this node preserves source view -> optional history -> write.
    const destinationAccess = checkedAccess(
      await get(destinationAccess$),
      target,
    );
    if (!destinationAccess) {
      return null;
    }
    return {
      target,
      botUserId: context.botUserId,
      conversationContext: context.conversationContext,
      conversationContextAllowed: conversation.conversationContextAllowed,
      messageContentEnabled: conversation.messageContentEnabled,
    };
  });
}
