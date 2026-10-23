import { command } from "ccstate";
import { delay } from "signal-timers";
import { and, eq, isNull, or } from "drizzle-orm";
import { discordChatThreadRoutes } from "@okouai/db/schema/discord-chat-thread-route";
import { now } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import {
  discordClient,
  type DiscordApiResult,
  type DiscordChannel,
} from "../external/discord-client";
import {
  requireDiscordBinding$,
  requireDiscordConversationAccess$,
  type DiscordConversationAccess,
} from "./discord-access.service";
import { discordApiFailure, discordUnavailable } from "./discord-api-response";

interface DiscordOutputDestination {
  readonly orgId: string;
  readonly userId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly attachFiles?: boolean;
  readonly allowOtherDmRecipients?: boolean;
  /** Upload preparation checks access without creating an empty thread. */
  readonly createThread: boolean;
}

/** Resolve a recipient without exposing any private message content. */
export const resolveDiscordOutputChannel$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly guildId?: string;
      readonly channelId?: string;
      readonly recipientId?: string;
    },
    signal: AbortSignal,
  ) => {
    if (args.channelId) {
      return { kind: "resolved" as const, channelId: args.channelId };
    }
    const current = await set(requireDiscordBinding$, args, signal);
    if (current.kind === "denied") {
      return current;
    }
    const recipientId =
      args.recipientId === "me"
        ? current.binding.discordUserId
        : args.recipientId;
    if (!recipientId || args.guildId !== undefined) {
      return { kind: "denied" as const, response: discordUnavailable() };
    }
    const opened = await discordClient.openDiscordDm(
      { botToken: current.botToken, userId: recipientId },
      signal,
    );
    if (opened.kind !== "ok") {
      return { kind: "denied" as const, response: discordApiFailure(opened) };
    }
    const channel = opened.data;
    if (
      channel.type !== 1 ||
      channel.guild_id !== undefined ||
      channel.recipients?.length !== 1 ||
      channel.recipients[0]?.id !== recipientId
    ) {
      return { kind: "denied" as const, response: discordUnavailable() };
    }
    return { kind: "resolved" as const, channelId: channel.id };
  },
);

function matchingThread(
  channel: DiscordChannel,
  args: {
    readonly channelId: string;
    readonly parentId: string;
    readonly guildId: string;
  },
): DiscordChannel {
  if (
    channel.id !== args.channelId ||
    channel.parent_id !== args.parentId ||
    channel.guild_id !== args.guildId ||
    ![10, 11, 12].includes(channel.type)
  ) {
    throw new Error("Discord thread does not match its starter message");
  }
  return channel;
}

const recordDiscordOutputDestination$ = command(
  async (
    { set },
    args: {
      readonly routeId: string;
      readonly connectionId: string;
      readonly userId: string;
      readonly channelId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [published] = await set(writeDb$)
      .update(discordChatThreadRoutes)
      .set({ destinationChannelId: args.channelId })
      .where(
        and(
          eq(discordChatThreadRoutes.id, args.routeId),
          eq(discordChatThreadRoutes.connectionId, args.connectionId),
          eq(discordChatThreadRoutes.userId, args.userId),
          or(
            isNull(discordChatThreadRoutes.destinationChannelId),
            eq(discordChatThreadRoutes.destinationChannelId, args.channelId),
          ),
        ),
      )
      .returning({ id: discordChatThreadRoutes.id });
    signal.throwIfAborted();
    return published !== undefined;
  },
);

/**
 * A message-started Discord thread has the starter message's ID. Pending
 * routes reserve that destination, but only an actual output creates it.
 */
const resolveDiscordOutputAccess$ = command(
  async (
    { get, set },
    args: DiscordOutputDestination,
    signal: AbortSignal,
  ): Promise<DiscordConversationAccess> => {
    const binding = await set(requireDiscordBinding$, args, signal);
    if (binding.kind === "denied") {
      return binding;
    }
    const [route] = await get(db$)
      .select({
        id: discordChatThreadRoutes.id,
        channelId: discordChatThreadRoutes.channelId,
      })
      .from(discordChatThreadRoutes)
      .where(
        and(
          eq(
            discordChatThreadRoutes.connectionId,
            binding.binding.connectionId,
          ),
          eq(discordChatThreadRoutes.userId, args.userId),
          eq(discordChatThreadRoutes.sessionKey, args.channelId),
          isNull(discordChatThreadRoutes.destinationChannelId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!route) {
      return await set(
        requireDiscordConversationAccess$,
        { ...args, mode: "write" },
        signal,
      );
    }
    let thread: DiscordApiResult<DiscordChannel> =
      await discordClient.fetchDiscordChannel(
        { botToken: binding.botToken, channelId: args.channelId },
        signal,
      );
    if (thread.kind === "unavailable" && thread.status === 404) {
      if (!args.createThread) {
        const source = await set(
          requireDiscordConversationAccess$,
          { ...args, channelId: route.channelId, mode: "write" },
          signal,
        );
        return source.kind === "allowed" &&
          source.binding.connectionId !== binding.binding.connectionId
          ? { kind: "denied", response: discordUnavailable() }
          : source;
      }
      const creation = await set(
        requireDiscordConversationAccess$,
        {
          ...args,
          channelId: route.channelId,
          mode: "write",
          createPublicThread: true,
        },
        signal,
      );
      if (creation.kind === "denied") {
        return creation;
      }
      if (creation.binding.connectionId !== binding.binding.connectionId) {
        return { kind: "denied", response: discordUnavailable() };
      }
      thread = await discordClient.createDiscordThreadFromMessage(
        {
          botToken: creation.botToken,
          channelId: route.channelId,
          messageId: args.channelId,
          name: "Okou conversation",
        },
        signal,
      );
      if (
        thread.kind !== "ok" &&
        !(thread.kind === "discord-error" && thread.status === 429)
      ) {
        // A user/another sender may have created it, or Discord's successful
        // create response may have been lost. Never create a second thread.
        const recovered = await discordClient.fetchDiscordChannel(
          { botToken: creation.botToken, channelId: args.channelId },
          signal,
        );
        if (recovered.kind === "ok") {
          thread = recovered;
        }
      }
    }
    if (thread.kind !== "ok") {
      return { kind: "denied", response: discordApiFailure(thread) };
    }
    const destination = await set(
      requireDiscordConversationAccess$,
      { ...args, mode: "write" },
      signal,
    );
    if (destination.kind === "denied") {
      return destination;
    }
    if (destination.binding.connectionId !== binding.binding.connectionId) {
      return { kind: "denied", response: discordUnavailable() };
    }
    matchingThread(thread.data, {
      channelId: args.channelId,
      parentId: route.channelId,
      guildId: destination.binding.guildId,
    });
    const published = await set(
      recordDiscordOutputDestination$,
      {
        routeId: route.id,
        connectionId: binding.binding.connectionId,
        userId: args.userId,
        channelId: args.channelId,
      },
      signal,
    );
    return published
      ? destination
      : { kind: "denied", response: discordUnavailable() };
  },
);

/** Retry only provider-declared rate limits, before any message send begins. */
export const requireDiscordOutputAccess$ = command(
  async (
    { set },
    args: DiscordOutputDestination,
    signal: AbortSignal,
  ): Promise<DiscordConversationAccess> => {
    const retryDeadline = now() + 10_000;
    for (let attempt = 1; ; attempt += 1) {
      const access = await set(resolveDiscordOutputAccess$, args, signal);
      if (
        access.kind === "allowed" ||
        !args.createThread ||
        access.response.status !== 429
      ) {
        return access;
      }
      const retryAfter = access.response.body.error.retryAfterSeconds;
      if (
        retryAfter === undefined ||
        attempt >= 3 ||
        retryAfter * 1000 >= retryDeadline - now()
      ) {
        return access;
      }
      await delay(retryAfter * 1000, { signal });
      // Each attempt rechecks ownership and resolves the provider's current
      // thread before trying to create it. No message is ever resent here.
    }
  },
);
