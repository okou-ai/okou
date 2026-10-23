import { now } from "../../lib/time";
import { joinAll } from "../utils";
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

/** Captured provider facts for one bounded operation, never a cross-request cache. */
export interface DiscordProviderSnapshot {
  readonly channel: DiscordChannel;
  readonly permissionChannel: DiscordChannel;
  readonly guild: DiscordGuildAccess | null;
  readonly discordUserId: string;
  readonly botUserId: string;
}

type ProviderAccess = {
  readonly kind: "allowed";
  readonly channel: DiscordChannel;
  readonly snapshot: DiscordProviderSnapshot;
};

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
  signal?: AbortSignal,
): Promise<{ kind: "allowed"; access: DiscordGuildAccess } | AccessFailure> {
  const [guild, roles, user, bot, self] = await joinAll([
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
  guildId?: string;
  discordUserId: string;
  botUserId: string;
  channelId: string;
  mode: DiscordAccessMode;
  attachFiles?: boolean;
  createPublicThread?: boolean;
  /** Explicit outbound delivery only; never prompt admission or private reads. */
  allowOtherDmRecipients?: boolean;
  /** Only reuse facts captured by this operation for these exact principals. */
  snapshot?: DiscordProviderSnapshot;
}

function observedChannel(
  snapshot: DiscordProviderSnapshot | undefined,
  channelId: string,
): DiscordChannel | undefined {
  if (snapshot?.channel.id === channelId) {
    return snapshot.channel;
  }
  if (snapshot?.permissionChannel.id === channelId) {
    return snapshot.permissionChannel;
  }
  return undefined;
}

async function resolvePermissionChannel(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
  signal?: AbortSignal,
): Promise<{ kind: "allowed"; channel: DiscordChannel } | AccessFailure> {
  if (isDiscordThread(channel)) {
    if (!channel.parent_id || !channel.thread_metadata) {
      return unavailable();
    }
    const observed = observedChannel(args.snapshot, channel.parent_id);
    const parent = observed
      ? { kind: "ok" as const, data: observed }
      : await discordClient.fetchDiscordChannel(
          { botToken: args.botToken, channelId: channel.parent_id },
          signal,
        );
    if (parent.kind !== "ok") {
      return { kind: "denied", response: discordApiFailure(parent) };
    }
    return validatePermissionChannel(channel, parent.data, args.guildId);
  }
  return { kind: "allowed", channel };
}

function validatePermissionChannel(
  channel: DiscordChannel,
  parent: DiscordChannel,
  guildId: string | undefined,
): { kind: "allowed"; channel: DiscordChannel } | AccessFailure {
  if (
    !channel.thread_metadata ||
    parent.id !== channel.parent_id ||
    parent.guild_id !== guildId ||
    ![0, 5, 15, 16].includes(parent.type)
  ) {
    return unavailable();
  }
  return { kind: "allowed", channel: parent };
}

function canStartPublicThread(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
) {
  return args.mode === "write" && [0, 5].includes(channel.type);
}

async function resolveDiscordDmAccess(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
  signal?: AbortSignal,
): Promise<{ kind: "allowed"; channel: DiscordChannel } | AccessFailure> {
  // Bot DMs may address other recipients only for explicit outbound delivery.
  if (
    channel.guild_id !== undefined ||
    channel.recipients?.length !== 1 ||
    !channel.recipients[0]?.id ||
    (channel.recipients[0].id !== args.discordUserId &&
      !(args.mode === "write" && args.allowOtherDmRecipients))
  ) {
    return unavailable();
  }
  const self = await discordClient.fetchDiscordCurrentUser(args, signal);
  if (self.kind !== "ok") {
    return { kind: "denied", response: discordApiFailure(self) };
  }
  if (self.data.id !== args.botUserId || self.data.bot !== true) {
    return unavailable();
  }
  return { kind: "allowed", channel };
}

export async function resolveDiscordProviderAccess(
  args: DiscordProviderAccessArgs,
  signal?: AbortSignal,
): Promise<ProviderAccess | AccessFailure> {
  signal?.throwIfAborted();
  const observed = args.snapshot;
  if (
    observed &&
    (observed.discordUserId !== args.discordUserId ||
      observed.botUserId !== args.botUserId ||
      (args.guildId !== undefined && observed.guild?.guild.id !== args.guildId))
  ) {
    return unavailable();
  }
  if (observed?.channel.id === args.channelId) {
    return authorizeDiscordSnapshot(observed, args);
  }
  if (observed?.permissionChannel.id === args.channelId) {
    return authorizeDiscordSnapshot(
      { ...observed, channel: observed.permissionChannel },
      args,
    );
  }
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
    const access = await resolveDiscordDmAccess(args, channel, signal);
    return access.kind === "denied"
      ? access
      : {
          ...access,
          snapshot: {
            channel,
            permissionChannel: channel,
            guild: null,
            discordUserId: args.discordUserId,
            botUserId: args.botUserId,
          },
        };
  }
  return await resolveGuildChannelAccess(args, channel, undefined, signal);
}

async function loadDiscordChannels(
  botToken: string,
  channelIds: readonly string[],
  signal?: AbortSignal,
): Promise<{ kind: "allowed"; channels: DiscordChannel[] } | AccessFailure> {
  const results = await joinAll(
    channelIds.map(async (channelId) => {
      const result = await discordClient.fetchDiscordChannel(
        { botToken, channelId },
        signal,
      );
      if (result.kind !== "ok") {
        return { kind: "denied" as const, response: discordApiFailure(result) };
      }
      return result.data.id === channelId
        ? { kind: "allowed" as const, channel: result.data }
        : unavailable();
    }),
  );
  const channels: DiscordChannel[] = [];
  for (const result of results) {
    if (result.kind === "denied") {
      return result;
    }
    channels.push(result.channel);
  }
  return { kind: "allowed", channels };
}

async function loadDiscordConversationChannels(
  botToken: string,
  guildId: string,
  channelIds: readonly string[],
  signal?: AbortSignal,
) {
  const channels = await loadDiscordChannels(botToken, channelIds, signal);
  if (channels.kind === "denied") {
    return channels;
  }
  if (
    channels.channels.some((channel) => {
      return channel.guild_id !== guildId;
    })
  ) {
    return unavailable();
  }
  // Fetch parents as soon as channels arrive, concurrently with guild facts.
  // A parent already read as the source/destination, or shared by two threads,
  // needs no additional read. These facts live only for this operation.
  const parentIds = [
    ...new Set(
      channels.channels.flatMap((channel) => {
        return isDiscordThread(channel) &&
          channel.parent_id &&
          !channelIds.includes(channel.parent_id)
          ? [channel.parent_id]
          : [];
      }),
    ),
  ];
  const parents = await loadDiscordChannels(botToken, parentIds, signal);
  return parents.kind === "denied"
    ? parents
    : { ...channels, parents: parents.channels };
}

/** One fresh read set for a prompt's source and destination, never ingress facts. */
export async function resolveDiscordProviderConversationAccess(
  args: Omit<DiscordProviderAccessArgs, "channelId" | "mode" | "snapshot"> & {
    readonly sourceChannelId: string;
    readonly destinationChannelId: string;
  },
  signal?: AbortSignal,
): Promise<
  | { kind: "allowed"; source: ProviderAccess; destination: ProviderAccess }
  | AccessFailure
> {
  if (!args.guildId) {
    // A DM has one exact recipient and cannot borrow a guild's authority.
    if (args.sourceChannelId !== args.destinationChannelId) {
      return unavailable();
    }
    const access = await resolveDiscordProviderAccess(
      { ...args, channelId: args.sourceChannelId, mode: "write" },
      signal,
    );
    if (access.kind === "denied") {
      return access;
    }
    return access.channel.type === 1
      ? { kind: "allowed", source: access, destination: access }
      : unavailable();
  }

  const channelIds = [
    ...new Set([args.sourceChannelId, args.destinationChannelId]),
  ];
  const [channels, guild] = await joinAll([
    loadDiscordConversationChannels(
      args.botToken,
      args.guildId,
      channelIds,
      signal,
    ),
    loadDiscordGuildAccess({ ...args, guildId: args.guildId }, signal),
  ]);
  if (channels.kind === "denied") {
    return channels;
  }
  if (guild.kind === "denied") {
    return guild;
  }
  const observedChannels = [...channels.channels, ...channels.parents];
  const accesses = await joinAll(
    channels.channels.map(async (channel) => {
      const permissionChannel = isDiscordThread(channel)
        ? observedChannels.find((observed) => {
            return observed.id === channel.parent_id;
          })
        : channel;
      if (!permissionChannel) {
        return unavailable();
      }
      return await resolveGuildChannelAccess(
        {
          ...args,
          channelId: channel.id,
          mode: channel.id === args.destinationChannelId ? "write" : "view",
        },
        channel,
        { guild: guild.access, permissionChannel },
        signal,
      );
    }),
  );
  const [source, destination = source] = accesses;
  if (!source || !destination) {
    throw new Error("Discord conversation is missing its requested channels");
  }
  if (source.kind === "denied") {
    return source;
  }
  return destination.kind === "denied"
    ? destination
    : { kind: "allowed", source, destination };
}

async function resolveGuildChannelAccess(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
  facts:
    | { guild: DiscordGuildAccess; permissionChannel: DiscordChannel }
    | undefined,
  signal?: AbortSignal,
): Promise<ProviderAccess | AccessFailure> {
  if (
    !channel.guild_id ||
    (args.guildId !== undefined && channel.guild_id !== args.guildId)
  ) {
    return unavailable();
  }
  const guildArgs = { ...args, guildId: channel.guild_id };
  const thread = isDiscordThread(channel);
  if (
    !isDiscordMessageChannel(channel) &&
    !(args.mode === "view" && (channel.type === 15 || channel.type === 16))
  ) {
    return unavailable();
  }
  const permissionChannel = facts
    ? thread
      ? validatePermissionChannel(
          channel,
          facts.permissionChannel,
          channel.guild_id,
        )
      : { kind: "allowed" as const, channel }
    : await resolvePermissionChannel(guildArgs, channel, signal);
  if (permissionChannel.kind === "denied") {
    return permissionChannel;
  }
  const guild = facts
    ? { kind: "allowed" as const, access: facts.guild }
    : args.snapshot?.guild?.guild.id === channel.guild_id
      ? { kind: "allowed" as const, access: args.snapshot.guild }
      : await loadDiscordGuildAccess(guildArgs, signal);
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
  const access = await requireThreadAccess(args, channel, permissions, signal);
  return access.kind === "denied"
    ? access
    : {
        ...access,
        snapshot: {
          channel,
          permissionChannel: permissionChannel.channel,
          guild: guild.access,
          discordUserId: args.discordUserId,
          botUserId: args.botUserId,
        },
      };
}

/** Re-evaluate a mode against the same operation's already verified facts. */
export function authorizeDiscordSnapshot(
  snapshot: DiscordProviderSnapshot,
  requirements: {
    readonly mode: DiscordAccessMode;
    readonly attachFiles?: boolean;
    readonly createPublicThread?: boolean;
    readonly allowOtherDmRecipients?: boolean;
  },
): ProviderAccess | AccessFailure {
  const { channel, guild } = snapshot;
  if (
    requirements.createPublicThread &&
    !(requirements.mode === "write" && [0, 5].includes(channel.type))
  ) {
    return unavailable();
  }
  if (!guild) {
    if (
      channel.type !== 1 ||
      channel.guild_id !== undefined ||
      channel.recipients?.length !== 1 ||
      !channel.recipients[0]?.id ||
      (channel.recipients[0].id !== snapshot.discordUserId &&
        !(requirements.mode === "write" && requirements.allowOtherDmRecipients))
    ) {
      return unavailable();
    }
    return { kind: "allowed", channel, snapshot };
  }
  if (
    !isDiscordMessageChannel(channel) &&
    !(requirements.mode === "view" && [15, 16].includes(channel.type))
  ) {
    return unavailable();
  }
  const permissions = discordSharedChannelPermissions(
    guild,
    snapshot.permissionChannel,
    requirements.mode,
    isDiscordThread(channel),
    requirements,
  );
  if (!permissions) {
    return unavailable();
  }
  const access = threadWriteAccess(requirements.mode, channel, permissions);
  return access.kind === "denied" ? access : { ...access, snapshot };
}

async function requireThreadAccess(
  args: DiscordProviderAccessArgs,
  channel: DiscordChannel,
  permissions: { user: bigint; bot: bigint },
  signal?: AbortSignal,
): Promise<{ kind: "allowed"; channel: DiscordChannel } | AccessFailure> {
  if (channel.type === 12) {
    const memberships = await joinAll(
      (
        [
          [args.discordUserId, permissions.user],
          [args.botUserId, permissions.bot],
        ] as const
      ).map(async ([userId, memberPermissions]) => {
        if (
          hasDiscordPermission(
            memberPermissions,
            DiscordPermission.ManageThreads,
          )
        ) {
          return { kind: "allowed" as const };
        }
        const membership = await discordClient.fetchDiscordThreadMember(
          { botToken: args.botToken, threadId: channel.id, userId },
          signal,
        );
        if (membership.kind !== "ok") {
          return {
            kind: "denied" as const,
            response: discordApiFailure(membership),
          };
        }
        if (
          membership.data.id !== channel.id ||
          membership.data.user_id !== userId
        ) {
          return unavailable();
        }
        return { kind: "allowed" as const };
      }),
    );
    for (const membership of memberships) {
      if (membership.kind === "denied") {
        return membership;
      }
    }
  }
  return threadWriteAccess(args.mode, channel, permissions);
}

function threadWriteAccess(
  mode: DiscordAccessMode,
  channel: DiscordChannel,
  permissions: { user: bigint; bot: bigint },
): { kind: "allowed"; channel: DiscordChannel } | AccessFailure {
  // Sending into an archived thread unarchives it, so only a moderator lock
  // closes a thread for writes. Discord lets MANAGE_THREADS holders send into
  // and reopen a locked thread; the bot's authority cannot stand in for the
  // sender's, so both principals must hold it.
  if (
    mode === "write" &&
    isDiscordThread(channel) &&
    channel.thread_metadata?.locked &&
    !(
      hasDiscordPermission(permissions.user, DiscordPermission.ManageThreads) &&
      hasDiscordPermission(permissions.bot, DiscordPermission.ManageThreads)
    )
  ) {
    return {
      kind: "denied",
      response: {
        status: 403,
        body: {
          error: {
            code: "DISCORD_THREAD_CLOSED",
            message:
              "This Discord thread is locked. Ask a moderator to unlock it before sending.",
          },
        },
      },
    };
  }
  return { kind: "allowed", channel };
}
