import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { db$ } from "../external/db";
import { requireDiscordPromptAccess$ } from "./discord-access.service";
import type { DiscordDeliveryTarget } from "./discord-chat-callback-payload";

interface DiscordChatRouteAccessArgs {
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly target: DiscordDeliveryTarget;
  readonly sourceChannelId: string;
  readonly hasConversationContext: boolean;
}

/** The sender's sticky route still owns this chat and exact destination. */
export function discordChatRouteReadPlan(
  args: Pick<DiscordChatRouteAccessArgs, "chatThreadId" | "userId" | "target">,
) {
  return {
    columns: {
      id: discordChatThreadRoutes.id,
      channelId: discordChatThreadRoutes.channelId,
      destinationChannelId: discordChatThreadRoutes.destinationChannelId,
    },
    condition: and(
      eq(discordChatThreadRoutes.chatThreadId, args.chatThreadId),
      eq(discordChatThreadRoutes.connectionId, args.target.connectionId),
      eq(discordChatThreadRoutes.id, args.target.routeId),
      or(
        eq(discordChatThreadRoutes.destinationChannelId, args.target.channelId),
        and(
          isNull(discordChatThreadRoutes.destinationChannelId),
          eq(discordChatThreadRoutes.sessionKey, args.target.channelId),
        ),
      ),
      eq(discordChatThreadRoutes.sessionKey, args.target.sessionKey),
      eq(discordChatThreadRoutes.userId, args.userId),
    ),
    limit: 1,
  };
}

export const loadDiscordChatRouteAccess$ = command(
  async (
    { get, set },
    args: DiscordChatRouteAccessArgs,
    signal: AbortSignal,
  ) => {
    const db = get(db$);
    const route = await (async () => {
      const plan = discordChatRouteReadPlan(args);
      const [route] = await db
        .select(plan.columns)
        .from(discordChatThreadRoutes)
        .where(plan.condition)
        .limit(plan.limit);
      return route;
    })();
    signal.throwIfAborted();
    if (!route) {
      return null;
    }
    const access = await set(
      requireDiscordPromptAccess$,
      {
        orgId: args.orgId,
        userId: args.userId,
        guildId: args.target.guildId ?? undefined,
        connectionId: args.target.connectionId,
        discordUserId: args.target.discordUserId,
        sourceChannelId: args.sourceChannelId,
        destinationChannelId: route.destinationChannelId ?? route.channelId,
        hasConversationContext: args.hasConversationContext,
      },
      signal,
    );
    if (!access) {
      return null;
    }
    return {
      ...access,
      routeId: route.id,
    };
  },
);
