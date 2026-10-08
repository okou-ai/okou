import type {
  DiscordChannel,
  DiscordGuild,
  DiscordMember,
  DiscordRole,
} from "../external/discord-client";

export const DiscordPermission = {
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  SendMessagesInThreads: 1n << 38n,
} as const;

export function hasDiscordPermission(permissions: bigint, required: bigint) {
  return (
    (permissions & DiscordPermission.Administrator) !== 0n ||
    (permissions & required) === required
  );
}

/** Discord applies everyone, aggregated role, then member overwrites. */
export function discordChannelPermissions(args: {
  guild: DiscordGuild;
  roles: readonly DiscordRole[];
  member: DiscordMember;
  channel: DiscordChannel;
}): bigint | null {
  if (args.member.user.id === args.guild.owner_id) {
    return DiscordPermission.Administrator;
  }
  const everyone = args.roles.find((role) => {
    return role.id === args.guild.id;
  });
  if (!everyone) {
    return null;
  }
  let permissions = BigInt(everyone.permissions);
  for (const roleId of args.member.roles) {
    const role = args.roles.find((entry) => {
      return entry.id === roleId;
    });
    if (!role) {
      // A role removed between the member and role reads grants no authority.
      return null;
    }
    permissions |= BigInt(role.permissions);
  }
  if (hasDiscordPermission(permissions, DiscordPermission.Administrator)) {
    return permissions;
  }
  const overwrites = args.channel.permission_overwrites;
  if (!overwrites) {
    return null;
  }
  const everyoneOverwrite = overwrites.find((entry) => {
    return entry.type === 0 && entry.id === args.guild.id;
  });
  if (everyoneOverwrite) {
    permissions =
      (permissions & ~BigInt(everyoneOverwrite.deny)) |
      BigInt(everyoneOverwrite.allow);
  }
  let deny = 0n;
  let allow = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && args.member.roles.includes(overwrite.id)) {
      deny |= BigInt(overwrite.deny);
      allow |= BigInt(overwrite.allow);
    }
  }
  permissions = (permissions & ~deny) | allow;
  const memberOverwrite = overwrites.find((entry) => {
    return entry.type === 1 && entry.id === args.member.user.id;
  });
  if (memberOverwrite) {
    permissions =
      (permissions & ~BigInt(memberOverwrite.deny)) |
      BigInt(memberOverwrite.allow);
  }
  return permissions;
}

export function isDiscordThread(channel: DiscordChannel) {
  return channel.type === 10 || channel.type === 11 || channel.type === 12;
}

export function isDiscordMessageChannel(channel: DiscordChannel) {
  return channel.type === 0 || channel.type === 5 || isDiscordThread(channel);
}
