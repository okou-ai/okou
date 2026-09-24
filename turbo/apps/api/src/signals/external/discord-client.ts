import { delay } from "signal-timers";
import { z } from "zod";

import { now } from "../../lib/time";
import { safeJsonParse, settle } from "../utils";

const DISCORD_API_ORIGIN = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_LIMIT_BUDGET_MS = 10_000;
const MAX_ATTEMPTS = 3;

export const discordSnowflakeSchema = z.string().regex(/^[1-9]\d{0,19}$/u);
const permissionsSchema = z.string().regex(/^\d+$/u);

export const discordUserSchema = z.object({
  id: discordSnowflakeSchema,
  username: z.string(),
  global_name: z.string().nullable().optional(),
  bot: z.boolean().optional(),
});

export const discordRoleSchema = z.object({
  id: discordSnowflakeSchema,
  name: z.string(),
  permissions: permissionsSchema,
});

export const discordMemberSchema = z.object({
  user: discordUserSchema,
  roles: z.array(discordSnowflakeSchema),
  nick: z.string().nullable().optional(),
  communication_disabled_until: z.iso
    .datetime({ offset: true })
    .nullable()
    .optional(),
});

const permissionOverwriteSchema = z.object({
  id: discordSnowflakeSchema,
  type: z.union([z.literal(0), z.literal(1)]),
  allow: permissionsSchema,
  deny: permissionsSchema,
});

export const discordChannelSchema = z.object({
  id: discordSnowflakeSchema,
  type: z.number().int().nonnegative(),
  guild_id: discordSnowflakeSchema.optional(),
  name: z.string().nullable().optional(),
  parent_id: discordSnowflakeSchema.nullable().optional(),
  permission_overwrites: z.array(permissionOverwriteSchema).optional(),
  recipients: z.array(discordUserSchema).optional(),
  thread_metadata: z
    .object({
      archived: z.boolean(),
      locked: z.boolean(),
      invitable: z.boolean().optional(),
      auto_archive_duration: z.number().int().positive(),
      archive_timestamp: z.iso.datetime({ offset: true }),
    })
    .optional(),
});

export const discordGuildSchema = z.object({
  id: discordSnowflakeSchema,
  name: z.string(),
  owner_id: discordSnowflakeSchema,
});

export const discordThreadMemberSchema = z.object({
  id: discordSnowflakeSchema,
  user_id: discordSnowflakeSchema,
  join_timestamp: z.iso.datetime({ offset: true }),
  flags: z.number().int().nonnegative(),
});

export const discordAttachmentSchema = z.object({
  id: discordSnowflakeSchema,
  filename: z.string(),
  size: z.number().int().nonnegative(),
  url: z.url(),
  proxy_url: z.url().optional(),
  content_type: z.string().optional(),
  description: z.string().optional(),
});

export const discordMessageSchema = z.object({
  id: discordSnowflakeSchema,
  channel_id: discordSnowflakeSchema,
  author: discordUserSchema,
  content: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
  edited_timestamp: z.iso.datetime({ offset: true }).nullable().optional(),
  attachments: z.array(discordAttachmentSchema),
  webhook_id: discordSnowflakeSchema.optional(),
  type: z.number().int().nonnegative().optional(),
  flags: z.number().int().nonnegative().optional(),
  nonce: z.union([z.string(), z.number().int()]).transform(String).optional(),
  message_reference: z
    .object({
      message_id: discordSnowflakeSchema.optional(),
      channel_id: discordSnowflakeSchema.optional(),
      guild_id: discordSnowflakeSchema.optional(),
    })
    .optional(),
  thread: discordChannelSchema.optional(),
});

export type DiscordUser = z.infer<typeof discordUserSchema>;
export type DiscordRole = z.infer<typeof discordRoleSchema>;
export type DiscordMember = z.infer<typeof discordMemberSchema>;
export type DiscordChannel = z.infer<typeof discordChannelSchema>;
export type DiscordGuild = z.infer<typeof discordGuildSchema>;
export type DiscordThreadMember = z.infer<typeof discordThreadMemberSchema>;
export type DiscordAttachment = z.infer<typeof discordAttachmentSchema>;
export type DiscordMessage = z.infer<typeof discordMessageSchema>;

export interface DiscordApiError {
  readonly kind: "discord-error";
  readonly status: number;
  readonly message: string;
  readonly code?: number;
  readonly retryAfterMs?: number;
  readonly global?: boolean;
}

export type DiscordApiResult<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "unavailable"; readonly status: 403 | 404 }
  | DiscordApiError;

interface DiscordBotCredentials {
  readonly botToken: string;
}

export interface DiscordUploadFile {
  readonly filename: string;
  readonly data: Blob;
  readonly description?: string;
}

const rateLimitSchema = z.object({
  retry_after: z
    .number()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER / 1000),
  global: z.boolean(),
});
const allowedMentions = Object.freeze({
  parse: Object.freeze([]),
  replied_user: false,
});

function discordError(status: number, message: string): DiscordApiError {
  return { kind: "discord-error", status, message };
}

function snowflake(id: string): string {
  return discordSnowflakeSchema.parse(id);
}

interface DiscordRequest<T> {
  readonly botToken?: string;
  readonly path: string;
  readonly method: "GET" | "POST" | "PATCH";
  readonly schema: z.ZodType<T>;
  readonly body?: string | FormData;
}

function decodeDiscordResponse<T>(
  response: Response,
  body: string,
  schema: z.ZodType<T>,
): DiscordApiResult<T> {
  if (response.status === 403 || response.status === 404) {
    return { kind: "unavailable", status: response.status };
  }
  if (!response.ok) {
    // Provider bodies and URL-bearing network errors may include private data.
    const error = z
      .object({ code: z.number().int() })
      .safeParse(safeJsonParse(body));
    return {
      ...discordError(
        response.status,
        `Discord API returned HTTP ${response.status}`,
      ),
      ...(error.success ? { code: error.data.code } : {}),
    };
  }
  const parsed = schema.safeParse(
    response.status === 204 ? undefined : safeJsonParse(body),
  );
  if (!parsed.success) {
    return discordError(502, "Discord returned an invalid response");
  }
  return { kind: "ok", data: parsed.data };
}

/** Never repeat a write after an ambiguous network, timeout, or server failure. */
async function requestDiscord<T>(
  args: DiscordRequest<T>,
  signal: AbortSignal,
): Promise<DiscordApiResult<T>> {
  signal.throwIfAborted();
  const headers: Record<string, string> = { accept: "application/json" };
  if (args.botToken !== undefined) {
    if (!args.botToken || /\s/u.test(args.botToken)) {
      return discordError(500, "Discord bot credentials are invalid");
    }
    headers.authorization = `Bot ${args.botToken}`;
  }
  if (typeof args.body === "string") {
    headers["content-type"] = "application/json";
  }
  let retryDeadline: number | undefined;
  for (let attempt = 1; ; attempt += 1) {
    const timeout = AbortSignal.timeout(
      retryDeadline === undefined
        ? REQUEST_TIMEOUT_MS
        : Math.min(REQUEST_TIMEOUT_MS, Math.max(1, retryDeadline - now())),
    );
    const requestSignal = AbortSignal.any([signal, timeout]);
    const responseResult = await settle(
      fetch(`${DISCORD_API_ORIGIN}${args.path}`, {
        method: args.method,
        headers,
        ...(args.body !== undefined ? { body: args.body } : {}),
        redirect: "error",
        signal: requestSignal,
      }),
      signal,
    );
    if (!responseResult.ok) {
      return discordError(
        timeout.aborted ? 504 : 502,
        timeout.aborted
          ? "Discord request timed out"
          : "Discord request failed",
      );
    }
    const response = responseResult.value;
    const bodyResult = await settle(response.text(), signal);
    if (!bodyResult.ok) {
      return discordError(
        timeout.aborted ? 504 : 502,
        "Discord response could not be read",
      );
    }
    signal.throwIfAborted();
    if (response.status === 429) {
      const rateLimit = rateLimitSchema.safeParse(
        safeJsonParse(bodyResult.value),
      );
      if (!rateLimit.success) {
        return discordError(
          429,
          "Discord returned an invalid rate limit response",
        );
      }
      const retryAfterMs = Math.ceil(rateLimit.data.retry_after * 1000);
      const limited: DiscordApiError = {
        kind: "discord-error",
        status: 429,
        message: "Discord rate limit exceeded",
        retryAfterMs,
        global: rateLimit.data.global,
      };
      retryDeadline ??= now() + RATE_LIMIT_BUDGET_MS;
      // Respect long waits instead of retrying earlier than Discord permits.
      if (attempt >= MAX_ATTEMPTS || retryAfterMs >= retryDeadline - now()) {
        return limited;
      }
      await delay(retryAfterMs, { signal });
      signal.throwIfAborted();
      if (now() >= retryDeadline) {
        return limited;
      }
      continue;
    }
    return decodeDiscordResponse(response, bodyResult.value, args.schema);
  }
}

function fetchDiscordCurrentUser(
  args: DiscordBotCredentials,
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordUser>> {
  return requestDiscord(
    { ...args, path: "/users/@me", method: "GET", schema: discordUserSchema },
    signal,
  );
}

function fetchDiscordChannel(
  args: DiscordBotCredentials & { readonly channelId: string },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordChannel>> {
  return requestDiscord(
    {
      ...args,
      path: `/channels/${snowflake(args.channelId)}`,
      method: "GET",
      schema: discordChannelSchema,
    },
    signal,
  );
}

function fetchDiscordGuild(
  args: DiscordBotCredentials & { readonly guildId: string },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordGuild>> {
  return requestDiscord(
    {
      ...args,
      path: `/guilds/${snowflake(args.guildId)}`,
      method: "GET",
      schema: discordGuildSchema,
    },
    signal,
  );
}

function fetchDiscordGuildMember(
  args: DiscordBotCredentials & {
    readonly guildId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordMember>> {
  return requestDiscord(
    {
      ...args,
      path: `/guilds/${snowflake(args.guildId)}/members/${snowflake(args.userId)}`,
      method: "GET",
      schema: discordMemberSchema,
    },
    signal,
  );
}

function fetchDiscordGuildRoles(
  args: DiscordBotCredentials & { readonly guildId: string },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordRole[]>> {
  return requestDiscord(
    {
      ...args,
      path: `/guilds/${snowflake(args.guildId)}/roles`,
      method: "GET",
      schema: z.array(discordRoleSchema),
    },
    signal,
  );
}

function fetchDiscordThreadMember(
  args: DiscordBotCredentials & {
    readonly threadId: string;
    readonly userId: string;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordThreadMember>> {
  return requestDiscord(
    {
      ...args,
      path: `/channels/${snowflake(args.threadId)}/thread-members/${snowflake(args.userId)}`,
      method: "GET",
      schema: discordThreadMemberSchema,
    },
    signal,
  );
}

function fetchDiscordGuildChannels(
  args: DiscordBotCredentials & { readonly guildId: string },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordChannel[]>> {
  return requestDiscord(
    {
      ...args,
      path: `/guilds/${snowflake(args.guildId)}/channels`,
      method: "GET",
      schema: z.array(discordChannelSchema),
    },
    signal,
  );
}

function fetchDiscordMessages(
  args: DiscordBotCredentials & {
    readonly channelId: string;
    readonly before?: string;
    readonly limit: number;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordMessage[]>> {
  const query = new URLSearchParams({
    limit: String(z.number().int().min(1).max(100).parse(args.limit)),
  });
  if (args.before !== undefined) {
    query.set("before", snowflake(args.before));
  }
  return requestDiscord(
    {
      ...args,
      path: `/channels/${snowflake(args.channelId)}/messages?${query.toString()}`,
      method: "GET",
      schema: z.array(discordMessageSchema),
    },
    signal,
  );
}

function fetchDiscordMessage(
  args: DiscordBotCredentials & {
    readonly channelId: string;
    readonly messageId: string;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordMessage>> {
  return requestDiscord(
    {
      ...args,
      path: `/channels/${snowflake(args.channelId)}/messages/${snowflake(args.messageId)}`,
      method: "GET",
      schema: discordMessageSchema,
    },
    signal,
  );
}

function createDiscordMessage(
  args: DiscordBotCredentials & {
    readonly channelId: string;
    readonly content: string;
    readonly replyToMessageId?: string;
    readonly files?: readonly DiscordUploadFile[];
    readonly nonce?: string;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordMessage>> {
  const files = args.files ?? [];
  if (files.length > 10) {
    return Promise.resolve(
      discordError(400, "Discord allows at most 10 attachments per message"),
    );
  }
  const content = z.string().max(2000).parse(args.content);
  if (!content && files.length === 0) {
    return Promise.resolve(
      discordError(400, "Discord message content or an attachment is required"),
    );
  }
  const payload = {
    content,
    allowed_mentions: allowedMentions,
    ...(args.replyToMessageId !== undefined
      ? {
          message_reference: {
            message_id: snowflake(args.replyToMessageId),
            fail_if_not_exists: true,
          },
        }
      : {}),
    ...(args.nonce !== undefined
      ? {
          nonce: z.string().min(1).max(25).parse(args.nonce),
          enforce_nonce: true,
        }
      : {}),
    ...(files.length > 0
      ? {
          attachments: files.map((file, index) => {
            return {
              id: index,
              filename: z.string().min(1).parse(file.filename),
              ...(file.description !== undefined
                ? { description: file.description }
                : {}),
            };
          }),
        }
      : {}),
  };
  let body: string | FormData = JSON.stringify(payload);
  if (files.length > 0) {
    const form = new FormData();
    form.append("payload_json", body);
    for (const [index, file] of files.entries()) {
      form.append(`files[${index}]`, file.data, file.filename);
    }
    body = form;
  }
  return requestDiscord(
    {
      botToken: args.botToken,
      path: `/channels/${snowflake(args.channelId)}/messages`,
      method: "POST",
      schema: discordMessageSchema,
      body,
    },
    signal,
  );
}

function editDiscordMessage(
  args: DiscordBotCredentials & {
    readonly channelId: string;
    readonly messageId: string;
    readonly content: string;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordMessage>> {
  return requestDiscord(
    {
      botToken: args.botToken,
      path: `/channels/${snowflake(args.channelId)}/messages/${snowflake(args.messageId)}`,
      method: "PATCH",
      schema: discordMessageSchema,
      body: JSON.stringify({
        content: z.string().min(1).max(2000).parse(args.content),
        allowed_mentions: allowedMentions,
      }),
    },
    signal,
  );
}

function openDiscordDm(
  args: DiscordBotCredentials & { readonly userId: string },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordChannel>> {
  return requestDiscord(
    {
      botToken: args.botToken,
      path: "/users/@me/channels",
      method: "POST",
      schema: discordChannelSchema,
      body: JSON.stringify({ recipient_id: snowflake(args.userId) }),
    },
    signal,
  );
}

function createDiscordThreadFromMessage(
  args: DiscordBotCredentials & {
    readonly channelId: string;
    readonly messageId: string;
    readonly name: string;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordChannel>> {
  return requestDiscord(
    {
      botToken: args.botToken,
      path: `/channels/${snowflake(args.channelId)}/messages/${snowflake(args.messageId)}/threads`,
      method: "POST",
      schema: discordChannelSchema,
      body: JSON.stringify({
        name: z.string().min(1).max(100).parse(args.name),
        auto_archive_duration: 1440,
      }),
    },
    signal,
  );
}

function sendDiscordTyping(
  args: DiscordBotCredentials & { readonly channelId: string },
  signal: AbortSignal,
): Promise<DiscordApiResult<undefined>> {
  return requestDiscord(
    {
      ...args,
      path: `/channels/${snowflake(args.channelId)}/typing`,
      method: "POST",
      schema: z.undefined(),
    },
    signal,
  );
}

const buttonSchema = z.union([
  z.object({
    type: z.literal(2),
    style: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    label: z.string().min(1).max(80),
    custom_id: z.string().min(1).max(100),
    disabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal(2),
    style: z.literal(5),
    label: z.string().min(1).max(80),
    url: z.url(),
    disabled: z.boolean().optional(),
  }),
]);
const selectSchema = z.object({
  type: z.literal(3),
  custom_id: z.string().min(1).max(100),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(100),
        value: z.string().min(1).max(100),
        description: z.string().max(100).optional(),
        default: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(25),
  placeholder: z.string().max(150).optional(),
  min_values: z.number().int().min(0).max(25).optional(),
  max_values: z.number().int().min(1).max(25).optional(),
  disabled: z.boolean().optional(),
});
export const discordActionRowSchema = z.object({
  type: z.literal(1),
  components: z.union([
    z.array(buttonSchema).min(1).max(5),
    z.tuple([selectSchema]),
  ]),
});
const interactionMessageSchema = z.object({
  content: z.string().max(2000).optional(),
  flags: z.literal(64).optional(),
  components: z.array(discordActionRowSchema).max(5).optional(),
});
const interactionResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(4), data: interactionMessageSchema }),
  z.object({
    type: z.literal(5),
    data: z.object({ flags: z.literal(64).optional() }).optional(),
  }),
  z.object({ type: z.literal(6) }),
  z.object({ type: z.literal(7), data: interactionMessageSchema }),
  z.object({
    type: z.literal(9),
    data: z.object({
      custom_id: z.string().min(1).max(100),
      title: z.string().min(1).max(45),
      components: z
        .array(
          z.object({
            type: z.literal(1),
            components: z.tuple([
              z.object({
                type: z.literal(4),
                custom_id: z.string().min(1).max(100),
                style: z.union([z.literal(1), z.literal(2)]),
                label: z.string().min(1).max(45),
                min_length: z.number().int().min(0).max(4000).optional(),
                max_length: z.number().int().min(1).max(4000).optional(),
                required: z.boolean().optional(),
                value: z.string().max(4000).optional(),
                placeholder: z.string().max(100).optional(),
              }),
            ]),
          }),
        )
        .min(1)
        .max(5),
    }),
  }),
]);
export type DiscordActionRow = z.infer<typeof discordActionRowSchema>;
export type DiscordInteractionResponse = z.infer<
  typeof interactionResponseSchema
>;

function interactionToken(token: string): string {
  return encodeURIComponent(z.string().min(1).max(2048).parse(token));
}

function createDiscordInteractionResponse(
  args: {
    readonly interactionId: string;
    readonly interactionToken: string;
    readonly response: DiscordInteractionResponse;
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<undefined>> {
  const response = interactionResponseSchema.parse(args.response);
  const body =
    response.type === 4 || response.type === 7
      ? {
          ...response,
          data: { ...response.data, allowed_mentions: allowedMentions },
        }
      : response;
  return requestDiscord(
    {
      path: `/interactions/${snowflake(args.interactionId)}/${interactionToken(args.interactionToken)}/callback`,
      method: "POST",
      schema: z.undefined(),
      body: JSON.stringify(body),
    },
    signal,
  );
}

function editDiscordOriginalInteractionResponse(
  args: {
    readonly applicationId: string;
    readonly interactionToken: string;
    readonly content: string;
    readonly components?: readonly DiscordActionRow[];
  },
  signal: AbortSignal,
): Promise<DiscordApiResult<DiscordMessage>> {
  const body = {
    content: z.string().max(2000).parse(args.content),
    allowed_mentions: allowedMentions,
    ...(args.components !== undefined
      ? {
          components: z
            .array(discordActionRowSchema)
            .max(5)
            .parse(args.components),
        }
      : {}),
  };
  return requestDiscord(
    {
      path: `/webhooks/${snowflake(args.applicationId)}/${interactionToken(args.interactionToken)}/messages/@original`,
      method: "PATCH",
      schema: discordMessageSchema,
      body: JSON.stringify(body),
    },
    signal,
  );
}

/** Shared REST surface for native tools, ingress, interactions, and delivery. */
export const discordClient = Object.freeze({
  fetchDiscordCurrentUser,
  fetchDiscordChannel,
  fetchDiscordGuild,
  fetchDiscordGuildMember,
  fetchDiscordGuildRoles,
  fetchDiscordThreadMember,
  fetchDiscordGuildChannels,
  fetchDiscordMessages,
  fetchDiscordMessage,
  createDiscordMessage,
  editDiscordMessage,
  openDiscordDm,
  createDiscordThreadFromMessage,
  sendDiscordTyping,
  createDiscordInteractionResponse,
  editDiscordOriginalInteractionResponse,
});
