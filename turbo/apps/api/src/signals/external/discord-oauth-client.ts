import { z } from "zod";
import { discordSnowflakeSchema, discordUserSchema } from "./discord-client";
import { safeJsonParse, settle } from "../utils";

const API = "https://discord.com/api/v10";
export const DISCORD_CONNECT_SCOPES = Object.freeze(["identify", "guilds"]);
export const DISCORD_INSTALL_SCOPES = Object.freeze([
  "bot",
  "applications.commands",
  ...DISCORD_CONNECT_SCOPES,
]);

export const discordOauthTokenSchema = z.object({
  access_token: z.string().min(1).regex(/^\S+$/u),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  scope: z.string(),
  guild: z.object({ id: discordSnowflakeSchema, name: z.string() }).optional(),
});
export const discordOauthAuthorizationSchema = z.object({
  application: z.object({ id: discordSnowflakeSchema }),
  scopes: z.array(z.string()),
  expires: z.iso.datetime({ offset: true }),
  user: discordUserSchema,
});
export const discordOauthGuildSchema = z.object({
  id: discordSnowflakeSchema,
  name: z.string(),
  owner: z.boolean(),
  permissions: z.string().regex(/^\d+$/u),
});
export const discordOauthBotApplicationSchema = z.object({
  id: discordSnowflakeSchema,
  bot: discordUserSchema,
});
export type DiscordOauthGuild = z.infer<typeof discordOauthGuildSchema>;
export type DiscordOauthResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: "provider_error" | "invalid_authorization";
    };

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: {
    readonly method?: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
  signal: AbortSignal,
): Promise<DiscordOauthResult<T>> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await settle(
    fetch(`${API}${path}`, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([signal, timeout]),
    }),
    signal,
  );
  if (!response.ok || !response.value.ok) {
    return { ok: false, error: "provider_error" };
  }
  const text = await settle(response.value.text(), signal);
  if (!text.ok) {
    return { ok: false, error: "provider_error" };
  }
  const parsed = schema.safeParse(safeJsonParse(text.value));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: "invalid_authorization" };
}

export function exchangeDiscordOauthCode(
  args: {
    readonly applicationId: string;
    readonly clientSecret: string;
    readonly code: string;
    readonly redirectUri: string;
  },
  signal: AbortSignal,
) {
  return request(
    "/oauth2/token",
    discordOauthTokenSchema,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: args.applicationId,
        client_secret: args.clientSecret,
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: args.redirectUri,
      }).toString(),
    },
    signal,
  );
}

export function fetchDiscordOauthAuthorization(
  token: string,
  signal: AbortSignal,
) {
  return request(
    "/oauth2/@me",
    discordOauthAuthorizationSchema,
    {
      headers: { authorization: `Bearer ${token}` },
    },
    signal,
  );
}
export function fetchDiscordOauthUser(token: string, signal: AbortSignal) {
  return request(
    "/users/@me",
    discordUserSchema,
    {
      headers: { authorization: `Bearer ${token}` },
    },
    signal,
  );
}
export function fetchDiscordOauthBotApplication(
  botToken: string,
  signal: AbortSignal,
) {
  return request(
    "/oauth2/applications/@me",
    discordOauthBotApplicationSchema,
    {
      headers: { authorization: `Bot ${botToken}` },
    },
    signal,
  );
}

/** Keyset pagination has no fixed page cap that could hide an eligible guild. */
export async function findDiscordOauthGuild(
  token: string,
  guildId: string,
  signal: AbortSignal,
): Promise<DiscordOauthResult<DiscordOauthGuild | null>> {
  let after = "0";
  for (;;) {
    const page = await request(
      `/users/@me/guilds?limit=200&after=${after}`,
      z.array(discordOauthGuildSchema).max(200),
      { headers: { authorization: `Bearer ${token}` } },
      signal,
    );
    if (!page.ok) {
      return page;
    }
    const guild = page.data.find((candidate) => {
      return candidate.id === guildId;
    });
    if (guild) {
      return { ok: true, data: guild };
    }
    if (page.data.length < 200) {
      return { ok: true, data: null };
    }
    const next = page.data.reduce((largest, candidate) => {
      return BigInt(candidate.id) > BigInt(largest) ? candidate.id : largest;
    }, after);
    if (next === after) {
      return { ok: false, error: "invalid_authorization" };
    }
    after = next;
  }
}
