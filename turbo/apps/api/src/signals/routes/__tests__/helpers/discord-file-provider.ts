import { randomBytes } from "node:crypto";

import { HttpResponse, http } from "msw";

import { server } from "../../../../mocks/server";

const DISCORD_API = "https://discord.com/api/v10";
const FILE_CHANNEL_PERMISSIONS = (
  (1n << 10n) |
  (1n << 11n) |
  (1n << 15n) |
  (1n << 16n) |
  (1n << 38n)
).toString();

export interface DiscordFileProviderIdentity {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly botUserId: string;
  readonly channelId: string;
}

interface ProviderAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly url: string;
  readonly content_type?: string;
}

export function discordSnowflake(): string {
  return (
    BigInt(`0x${randomBytes(8).toString("hex")}`) + 1_000_000_000_000_000_000n
  ).toString();
}

export function discordFileMessage(args: {
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly attachment: ProviderAttachment;
  readonly nonce?: string;
  readonly bot?: boolean;
}) {
  return {
    id: args.messageId,
    channel_id: args.channelId,
    author: {
      id: args.authorId,
      username: args.bot ? "okou-test" : "file-owner",
      bot: args.bot ?? false,
    },
    content: "",
    timestamp: "2026-09-24T09:00:00.000Z",
    edited_timestamp: null,
    attachments: [args.attachment],
    ...(args.nonce === undefined ? {} : { nonce: args.nonce }),
  };
}

/** External Discord fixtures only; verified Okou bindings use A's guarded API. */
export function mockDiscordFileProvider(identity: DiscordFileProviderIdentity) {
  const channel = {
    id: identity.channelId,
    type: 0,
    guild_id: identity.guildId,
    name: "reports",
    permission_overwrites: [],
  };
  server.use(
    http.get(`${DISCORD_API}/users/@me`, () => {
      return HttpResponse.json({
        id: identity.botUserId,
        username: "okou-test",
        bot: true,
      });
    }),
    http.get(`${DISCORD_API}/channels/${identity.channelId}`, () => {
      return HttpResponse.json(channel);
    }),
    http.get(`${DISCORD_API}/guilds/${identity.guildId}`, () => {
      return HttpResponse.json({
        id: identity.guildId,
        name: "Discord file tests",
        owner_id: discordSnowflake(),
      });
    }),
    http.get(`${DISCORD_API}/guilds/${identity.guildId}/roles`, () => {
      return HttpResponse.json([
        {
          id: identity.guildId,
          name: "@everyone",
          permissions: FILE_CHANNEL_PERMISSIONS,
        },
      ]);
    }),
    http.get(`${DISCORD_API}/guilds/${identity.guildId}/channels`, () => {
      return HttpResponse.json([channel]);
    }),
    ...[identity.discordUserId, identity.botUserId].map((userId) => {
      return http.get(
        `${DISCORD_API}/guilds/${identity.guildId}/members/${userId}`,
        () => {
          return HttpResponse.json({
            user: {
              id: userId,
              username: "member",
              bot: userId === identity.botUserId,
            },
            roles: [],
            communication_disabled_until: null,
          });
        },
      );
    }),
  );
}

export const discordApiOrigin = DISCORD_API;
