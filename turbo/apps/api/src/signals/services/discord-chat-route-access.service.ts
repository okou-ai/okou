import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import type { Db } from "../external/db";
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
export async function findDiscordChatRoute(
  db: Db,
  args: Pick<DiscordChatRouteAccessArgs, "chatThreadId" | "userId" | "target">,
): Promise<
  | {
      readonly id: string;
      readonly channelId: string;
      readonly destinationChannelId: string | null;
    }
  | undefined
> {
  const [route] = await db
    .select({
      id: discordChatThreadRoutes.id,
      channelId: discordChatThreadRoutes.channelId,
      destinationChannelId: discordChatThreadRoutes.destinationChannelId,
    })
    .from(discordChatThreadRoutes)
    .where(
      and(
        eq(discordChatThreadRoutes.chatThreadId, args.chatThreadId),
        eq(discordChatThreadRoutes.connectionId, args.target.connectionId),
        eq(discordChatThreadRoutes.id, args.target.routeId),
        or(
          eq(
            discordChatThreadRoutes.destinationChannelId,
            args.target.channelId,
          ),
          and(
            isNull(discordChatThreadRoutes.destinationChannelId),
            eq(discordChatThreadRoutes.sessionKey, args.target.channelId),
          ),
        ),
        eq(discordChatThreadRoutes.sessionKey, args.target.sessionKey),
        eq(discordChatThreadRoutes.userId, args.userId),
      ),
    )
    .limit(1);
  return route;
}

export const loadDiscordChatRouteAccess$ = command(
  async (
    { set },
    db: Db,
    args: DiscordChatRouteAccessArgs,
    signal: AbortSignal,
  ) => {
    const route = await findDiscordChatRoute(db, args);
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
