import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import type { Db } from "../external/db";
import { requireDiscordConversationAccess$ } from "./discord-access.service";
import type { DiscordDeliveryTarget } from "./discord-chat-callback-payload";

interface DiscordChatRouteAccessArgs {
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly target: DiscordDeliveryTarget;
  readonly sourceChannelId: string;
  readonly hasConversationContext: boolean;
}

async function loadCurrentConversationAccess(
  args: DiscordChatRouteAccessArgs,
  channelId: string,
  mode: "view" | "read" | "write",
  signal: AbortSignal,
) {
  const access = await createStore().set(
    requireDiscordConversationAccess$,
    {
      orgId: args.orgId,
      userId: args.userId,
      guildId: args.target.guildId,
      channelId,
      mode,
    },
    signal,
  );
  signal.throwIfAborted();
  if (access.kind === "denied") {
    if (access.response.status === 403 || access.response.status === 404) {
      return null;
    }
    throw new Error(`Discord access check failed: ${access.response.status}`);
  }
  if (
    access.binding.connectionId !== args.target.connectionId ||
    access.binding.discordUserId !== args.target.discordUserId
  ) {
    return null;
  }
  return access;
}

export async function loadDiscordChatRouteAccess(
  db: Db,
  args: DiscordChatRouteAccessArgs,
  signal: AbortSignal,
) {
  const [route] = await db
    .select({ id: discordChatThreadRoutes.id })
    .from(discordChatThreadRoutes)
    .where(
      and(
        eq(discordChatThreadRoutes.chatThreadId, args.chatThreadId),
        eq(discordChatThreadRoutes.connectionId, args.target.connectionId),
        eq(discordChatThreadRoutes.id, args.target.routeId),
        eq(discordChatThreadRoutes.destinationChannelId, args.target.channelId),
        eq(discordChatThreadRoutes.sessionKey, args.target.sessionKey),
        eq(discordChatThreadRoutes.userId, args.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!route) {
    return null;
  }
  const sourceAccess = await loadCurrentConversationAccess(
    args,
    args.sourceChannelId,
    "view",
    signal,
  );
  if (!sourceAccess) {
    return null;
  }
  // The bot DM channel is shared by every org and DM session of this Discord
  // user, so its history never reaches a run, including context persisted
  // before DM ingress stopped reading it.
  let conversationContextAllowed =
    sourceAccess.channel.type !== 1 && sourceAccess.messageContentEnabled;
  if (args.hasConversationContext && conversationContextAllowed) {
    conversationContextAllowed =
      (await loadCurrentConversationAccess(
        args,
        args.sourceChannelId,
        "read",
        signal,
      )) !== null;
  }
  const access = await loadCurrentConversationAccess(
    args,
    args.target.channelId,
    "write",
    signal,
  );
  if (!access) {
    return null;
  }
  return { ...access, routeId: route.id, conversationContextAllowed };
}
