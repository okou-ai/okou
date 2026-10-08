import { now } from "../../lib/time";
import type { DiscordAppConfig } from "./discord-config";
import {
  discordClient,
  discordSnowflakeSchema,
} from "../external/discord-client";
import {
  DISCORD_CONNECT_SCOPES,
  DISCORD_INSTALL_SCOPES,
  exchangeDiscordOauthCode,
  fetchDiscordOauthAuthorization,
  fetchDiscordOauthUser,
  fetchDiscordOauthBotApplication,
  findDiscordOauthGuild,
} from "../external/discord-oauth-client";

export type DiscordOauthVerificationError =
  | "provider_error"
  | "invalid_authorization"
  | "guild_unverified"
  | "bot_missing";
type Result<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: DiscordOauthVerificationError };
interface GrantArgs {
  readonly config: DiscordAppConfig;
  readonly clientSecret: string;
  readonly flow: "install" | "connect";
  readonly guildId: string | null;
  readonly redirectUri: string;
  readonly code: string;
  readonly guildHint: string | undefined;
}
function failed(error: DiscordOauthVerificationError): Result<never> {
  return { ok: false, error };
}

async function verifyIdentity(args: GrantArgs, signal: AbortSignal) {
  const exchanged = await exchangeDiscordOauthCode(
    {
      applicationId: args.config.applicationId,
      clientSecret: args.clientSecret,
      code: args.code,
      redirectUri: args.redirectUri,
    },
    signal,
  );
  if (!exchanged.ok) {
    return exchanged;
  }
  const token = exchanged.data;
  const scopes =
    args.flow === "install" ? DISCORD_INSTALL_SCOPES : DISCORD_CONNECT_SCOPES;
  if (
    !scopes.every((scope) => {
      return token.scope.split(/\s+/u).includes(scope);
    })
  ) {
    return failed("invalid_authorization");
  }
  const authorization = await fetchDiscordOauthAuthorization(
    token.access_token,
    signal,
  );
  if (!authorization.ok) {
    return authorization;
  }
  if (
    authorization.data.application.id !== args.config.applicationId ||
    !scopes.every((scope) => {
      return authorization.data.scopes.includes(scope);
    }) ||
    Date.parse(authorization.data.expires) <= now()
  ) {
    return failed("invalid_authorization");
  }
  const user = await fetchDiscordOauthUser(token.access_token, signal);
  if (!user.ok) {
    return user;
  }
  if (user.data.bot || user.data.id !== authorization.data.user.id) {
    return failed("invalid_authorization");
  }
  return { ok: true as const, data: { token, user: user.data } };
}

async function verifyBot(
  config: DiscordAppConfig,
  signal: AbortSignal,
): Promise<Result<string>> {
  const application = await fetchDiscordOauthBotApplication(
    config.botToken,
    signal,
  );
  if (!application.ok) {
    return application;
  }
  if (
    application.data.id !== config.applicationId ||
    application.data.bot.bot !== true
  ) {
    return failed("invalid_authorization");
  }
  const bot = await discordClient.fetchDiscordCurrentUser(config, signal);
  if (bot.kind !== "ok") {
    return failed(
      bot.kind === "unavailable" ? "bot_missing" : "provider_error",
    );
  }
  if (bot.data.bot !== true || bot.data.id !== application.data.bot.id) {
    return failed("invalid_authorization");
  }
  return { ok: true, data: bot.data.id };
}

async function verifyGuild(
  args: {
    readonly config: DiscordAppConfig;
    readonly guildId: string;
    readonly discordUserId: string;
  },
  signal: AbortSignal,
): Promise<Result<string>> {
  const present = await discordClient.fetchDiscordGuild(
    { ...args.config, guildId: args.guildId },
    signal,
  );
  if (present.kind !== "ok") {
    return failed(
      present.kind === "unavailable" ? "bot_missing" : "provider_error",
    );
  }
  if (present.data.id !== args.guildId) {
    return failed("guild_unverified");
  }
  const member = await discordClient.fetchDiscordGuildMember(
    { ...args.config, guildId: args.guildId, userId: args.discordUserId },
    signal,
  );
  if (member.kind !== "ok") {
    return failed(
      member.kind === "unavailable" ? "guild_unverified" : "provider_error",
    );
  }
  if (member.data.user.id !== args.discordUserId) {
    return failed("guild_unverified");
  }
  return { ok: true, data: present.data.name };
}

/** Token endpoint and current provider authority prove identities, never callback metadata. */
export async function verifyDiscordOauthGrant(
  args: GrantArgs,
  signal: AbortSignal,
): Promise<
  Result<{
    readonly guildId: string;
    readonly guildName: string;
    readonly discordUserId: string;
    readonly botUserId: string;
  }>
> {
  const identity = await verifyIdentity(args, signal);
  if (!identity.ok) {
    return identity;
  }
  const { token, user } = identity.data;
  // Discord documents token.guild with Bot Requires OAuth2 Code Grant enabled.
  // Reject missing proof instead of substituting the untrusted guild_id hint.
  const guildId = args.flow === "install" ? token.guild?.id : args.guildId;
  if (!guildId || (args.guildId && args.guildId !== guildId)) {
    return failed("guild_unverified");
  }
  if (
    args.guildHint !== undefined &&
    (!discordSnowflakeSchema.safeParse(args.guildHint).success ||
      args.guildHint !== guildId)
  ) {
    return failed("guild_unverified");
  }
  const guild = await findDiscordOauthGuild(
    token.access_token,
    guildId,
    signal,
  );
  if (!guild.ok) {
    return guild;
  }
  if (!guild.data) {
    return failed("guild_unverified");
  }
  // Discord server owner, MANAGE_GUILD or ADMINISTRATOR can install a bot.
  if (
    args.flow === "install" &&
    !guild.data.owner &&
    (BigInt(guild.data.permissions) & 40n) === 0n
  ) {
    return failed("guild_unverified");
  }
  const bot = await verifyBot(args.config, signal);
  if (!bot.ok) {
    return bot;
  }
  const present = await verifyGuild(
    { config: args.config, guildId, discordUserId: user.id },
    signal,
  );
  if (!present.ok) {
    return present;
  }
  return {
    ok: true,
    data: {
      guildId,
      guildName: present.data,
      discordUserId: user.id,
      botUserId: bot.data,
    },
  };
}
