import { accept } from "@okouai/connectors/accept";
import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  type infer as zInfer,
  type ZodType,
} from "zod";

import { logger } from "../../lib/log";
import { discordSnowflakeSchema, discordUserSchema } from "./discord-client";
import { safeJsonParse, settle } from "../utils";

const L = logger("DiscordOauthClient");
const API = "https://discord.com/api/v10";
export const DISCORD_CONNECT_SCOPES = Object.freeze(["identify", "guilds"]);
export const DISCORD_INSTALL_SCOPES = Object.freeze([
  "bot",
  "applications.commands",
  ...DISCORD_CONNECT_SCOPES,
]);

export const discordOauthTokenSchema = object({
  access_token: string().min(1).max(4096).regex(/^\S+$/u),
  token_type: literal("Bearer"),
  expires_in: number().int().positive(),
  scope: string().max(2048),
  guild: object({
    id: discordSnowflakeSchema,
    name: string().max(255),
  }).optional(),
});
export const discordOauthAuthorizationSchema = object({
  application: object({ id: discordSnowflakeSchema }),
  scopes: array(string().max(128)).max(32),
  expires: iso.datetime({ offset: true }),
  user: discordUserSchema,
});
export const discordOauthGuildSchema = object({
  id: discordSnowflakeSchema,
  name: string().max(255),
  owner: boolean(),
  permissions: string().regex(/^\d+$/u),
});
export const discordOauthBotApplicationSchema = object({
  id: discordSnowflakeSchema,
  // Discord's Application structure explicitly makes this partial user optional.
  bot: object({ id: discordSnowflakeSchema }).optional(),
});
export type DiscordOauthGuild = zInfer<typeof discordOauthGuildSchema>;
export type DiscordOauthResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error: "provider_error" | "invalid_authorization";
    };

async function request<T>(
  path: string,
  schema: ZodType<T>,
  init: {
    readonly method?: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
  signal: AbortSignal,
): Promise<DiscordOauthResult<T>> {
  const response = await settle(
    accept(
      fetch(`${API}${path}`, {
        ...init,
        signal,
      }),
      [200],
    ),
    signal,
  );
  if (!response.ok) {
    return { ok: false, error: "provider_error" };
  }
  const text = await settle(response.value.text(), signal);
  if (!text.ok) {
    return { ok: false, error: "provider_error" };
  }
  const parsed = schema.safeParse(safeJsonParse(text.value));
  if (!parsed.success) {
    // Schema paths and codes contain no provider values; never log the body,
    // Zod messages, request headers, or query parameters on this OAuth boundary.
    L.warn("Discord OAuth response failed validation", {
      endpoint: path.split("?")[0],
      issues: parsed.error.issues.slice(0, 8).map((issue) => {
        return { path: issue.path, code: issue.code };
      }),
    });
    return { ok: false, error: "invalid_authorization" };
  }
  return { ok: true, data: parsed.data };
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
      array(discordOauthGuildSchema).max(200),
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
      L.warn("Discord OAuth guild pagination did not advance");
      return { ok: false, error: "invalid_authorization" };
    }
    after = next;
  }
}
