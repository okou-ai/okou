import { now } from "../../lib/time";
import {
  discordClient,
  type DiscordChannel,
  type DiscordGuild,
  type DiscordMember,
  type DiscordRole,
} from "../external/discord-client";
import {
  discordApiFailure,
  discordUnavailable,
  type DiscordFailureResponse,
} from "./discord-api-response";
import {
  DiscordPermission,
  discordChannelPermissions,
  hasDiscordPermission,
  isDiscordMessageChannel,
  isDiscordThread,
} from "./discord-permissions";

export type DiscordAccessMode = "view" | "read" | "write";

export interface DiscordGuildAccess {
  guild: DiscordGuild;
  roles: readonly DiscordRole[];
  user: DiscordMember;
  bot: DiscordMember;
}

type AccessFailure = {
  kind: "denied";
  response: DiscordFailureResponse;
};

function unavailable(): AccessFailure {
  return { kind: "denied", response: discordUnavailable() };
}

export async function loadDiscordGuildAccess(
  args: {
    botToken: string;
    guildId: string;
    discordUserId: string;
    botUserId: string;
  },
  signal: AbortSignal,
): Promise<{ kind: "allowed"; access: DiscordGuildAccess } | AccessFailure> {
  const [guild, roles, user, bot, self] = await Promise.all([
    discordClient.fetchDiscordGuild(args, signal),
    discordClient.fetchDiscordGuildRoles(args, signal),
    discordClient.fetchDiscordGuildMember(
      { ...args, userId: args.discordUserId },
      signal,
    ),
    discordClient.fetchDiscordGuildMember(
      { ...args, userId: args.botUserId },
      signal,
    ),
    discordClient.fetchDiscordCurrentUser(args, signal),
  ]);
  if (guild.kind !== "ok") {
    return { kind: "denied", response: discordApiFailure(guild) };
  }
  if (roles.kind !== "ok") {
    return { kind: "denied", response: discordApiFailure(roles) };
  }
  if (user.kind !== "ok") {
    return { kind: "denied", response: discordApiFailure(user) };
  }
  if (bot.kind !== "ok") {
    return { kind: "denied", response: discordApiFailure(bot) };
  }
  if (self.kind !== "ok") {
    return { kind: "denied", response: discordApiFailure(self) };
  }
  if (
    guild.data.id !== args.guildId ||
    user.data.user.id !== args.discordUserId ||
    bot.data.user.id !== args.botUserId ||
    self.data.id !== args.botUserId ||
    self.data.bot !== true
  ) {
    return unavailable();
  }
  return {
    kind: "allowed",
    access: {
      guild: guild.data,
      roles: roles.data,
      user: user.data,
      bot: bot.data,
    },
  };
}

function timedOut(member: DiscordMember) {
  return (
    member.communication_disabled_until !== undefined &&
    member.communication_disabled_until !== null &&
    Date.parse(member.communication_disabled_until) > now()
  );
}

export function discordSharedChannelPermissions(
  access: DiscordGuildAccess,
  channel: DiscordChannel,
  mode: DiscordAccessMode,
  thread: boolean,
  requirements: { attachFiles?: boolean; createPublicThread?: boolean } = {},
): { user: bigint; bot: bigint } | null {
  if (channel.guild_id !== access.guild.id) {
    return null;
  }
  const user = discordChannelPermissions({
    ...access,
    member: access.user,
    channel,
  });
  const bot = discordChannelPermissions({
    ...access,
    member: access.bot,
    channel,
  });
  if (user === null || bot === null) {
    return null;
  }
  let required = DiscordPermission.ViewChannel;
  if (mode === "read") {
    required |= DiscordPermission.ReadMessageHistory;
  }
  if (mode === "write") {
    if (timedOut(access.user) || timedOut(access.bot)) {
      return null;
    }
    required |= thread
      ? DiscordPermission.SendMessagesInThreads
      : DiscordPermission.SendMessages;
  }
  if (requirements.createPublicThread) {
    required |= DiscordPermission.CreatePublicThreads;
  }
  if (requirements.attachFiles) {
    required |= DiscordPermission.AttachFiles;
  }
  return hasDiscordPermission(user, required) &&
    hasDiscordPermission(bot, required)
    ? { user, bot }
    : null;
}

interface DiscordProviderAccessArgs {
  botToken: string;
  guildId: string;
  discordUserId: string;
  botUserId: string;
  channelId: string;
  mode: DiscordAccessMode;
  attachFiles?: boolean;
  createPublicThread?: boolean;
}

async function resolvePermissionChannel(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
  signal: AbortSignal,
): Promise<{ kind: "allowed"; channel: DiscordChannel } | AccessFailure> {
  if (isDiscordThread(channel)) {
    if (!channel.parent_id || !channel.thread_metadata) {
      return unavailable();
    }
    const parent = await discordClient.fetchDiscordChannel(
      { botToken: args.botToken, channelId: channel.parent_id },
      signal,
    );
    if (parent.kind !== "ok") {
      return { kind: "denied", response: discordApiFailure(parent) };
    }
    if (
      parent.data.id !== channel.parent_id ||
      parent.data.guild_id !== args.guildId ||
      ![0, 5, 15, 16].includes(parent.data.type)
    ) {
      return unavailable();
    }
    return { kind: "allowed", channel: parent.data };
  }
  return { kind: "allowed", channel };
}

function canStartPublicThread(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
) {
  return args.mode === "write" && [0, 5].includes(channel.type);
}

export async function resolveDiscordProviderAccess(
  args: DiscordProviderAccessArgs,
  signal: AbortSignal,
): Promise<{ kind: "allowed"; channel: DiscordChannel } | AccessFailure> {
  const result = await discordClient.fetchDiscordChannel(args, signal);
  if (result.kind !== "ok") {
    return { kind: "denied", response: discordApiFailure(result) };
  }
  const channel = result.data;
  if (channel.id !== args.channelId) {
    return unavailable();
  }
  // Message-based public threads can only start in guild text/announcement
  // channels. A DM, forum/media parent or existing thread cannot be promoted.
  if (args.createPublicThread && !canStartPublicThread(args, channel)) {
    return unavailable();
  }
  if (channel.type === 1) {
    // A bot can only fetch its own DMs; the single other recipient must be
    // the exact connected sender, never a supplied arbitrary Discord user.
    if (
      channel.guild_id !== undefined ||
      channel.recipients?.length !== 1 ||
      channel.recipients[0]?.id !== args.discordUserId
    ) {
      return unavailable();
    }
    const guild = await loadDiscordGuildAccess(args, signal);
    return guild.kind === "allowed" ? { kind: "allowed", channel } : guild;
  }
  if (channel.guild_id !== args.guildId) {
    return unavailable();
  }
  const thread = isDiscordThread(channel);
  if (
    !isDiscordMessageChannel(channel) &&
    !(args.mode === "view" && (channel.type === 15 || channel.type === 16))
  ) {
    return unavailable();
  }
  const permissionChannel = await resolvePermissionChannel(
    args,
    channel,
    signal,
  );
  if (permissionChannel.kind === "denied") {
    return permissionChannel;
  }
  const guild = await loadDiscordGuildAccess(args, signal);
  if (guild.kind === "denied") {
    return guild;
  }
  const permissions = discordSharedChannelPermissions(
    guild.access,
    permissionChannel.channel,
    args.mode,
    thread,
    args,
  );
  if (!permissions) {
    return unavailable();
  }
  return await requireThreadAccess(args, channel, permissions, signal);
}

async function requireThreadAccess(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
  permissions: { user: bigint; bot: bigint },
  signal: AbortSignal,
): Promise<{ kind: "allowed"; channel: DiscordChannel } | AccessFailure> {
  if (channel.type === 12) {
    for (const [userId, memberPermissions] of [
      [args.discordUserId, permissions.user],
      [args.botUserId, permissions.bot],
    ] as const) {
      if (
        hasDiscordPermission(memberPermissions, DiscordPermission.ManageThreads)
      ) {
        continue;
      }
      const membership = await discordClient.fetchDiscordThreadMember(
        { botToken: args.botToken, threadId: channel.id, userId },
        signal,
      );
      if (membership.kind !== "ok") {
        return { kind: "denied", response: discordApiFailure(membership) };
      }
      if (
        membership.data.id !== channel.id ||
        membership.data.user_id !== userId
      ) {
        return unavailable();
      }
    }
  }
  if (
    args.mode === "write" &&
    isDiscordThread(channel) &&
    (channel.thread_metadata?.archived || channel.thread_metadata?.locked)
  ) {
    return {
      kind: "denied",
      response: {
        status: 403,
        body: {
          error: {
            code: "DISCORD_THREAD_CLOSED",
            message:
              "This Discord thread is archived or locked. Reopen it in Discord before sending.",
          },
        },
      },
    };
  }
  return { kind: "allowed", channel };
}
