import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** Discord snowflakes must never pass through a JavaScript number. */
export const discordSnowflakeSchema = z
  .string()
  .regex(/^[1-9]\d{0,19}$/, "Expected a Discord snowflake ID")
  .refine(
    (value) => {
      return value.length < 20 || value <= "18446744073709551615";
    },
    { message: "Discord snowflake ID exceeds the unsigned 64-bit range" },
  );

export const discordNativeErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    retryAfterSeconds: z.number().nonnegative().optional(),
  }),
});

export const discordChannelListQuerySchema = z.object({
  guildId: discordSnowflakeSchema.optional(),
});

export const discordHistoryQuerySchema = z.object({
  guildId: discordSnowflakeSchema.optional(),
  channelId: discordSnowflakeSchema,
  before: discordSnowflakeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const discordRepliesQuerySchema = discordHistoryQuerySchema.extend({
  messageId: discordSnowflakeSchema,
});

const discordListedChannelSchema = z.object({
  id: discordSnowflakeSchema,
  name: z.string(),
  type: z.number().int(),
  guildId: discordSnowflakeSchema,
  parentId: discordSnowflakeSchema.nullable(),
});

export const discordHistoryMessageSchema = z.object({
  id: discordSnowflakeSchema,
  channelId: discordSnowflakeSchema,
  content: z.string(),
  author: z.object({
    id: discordSnowflakeSchema,
    username: z.string(),
    bot: z.boolean().optional(),
  }),
  timestamp: z.string(),
  url: z.string().url(),
  attachments: z.array(
    z.object({
      id: discordSnowflakeSchema,
      filename: z.string(),
      size: z.number().int().nonnegative(),
      url: z.string().url(),
      contentType: z.string().optional(),
    }),
  ),
});

const discordChannelListResponseSchema = z.object({
  channels: z.array(discordListedChannelSchema),
});

const discordHistoryResponseSchema = z.object({
  channelId: discordSnowflakeSchema,
  contextMode: z.enum(["full", "mentions_only"]),
  messages: z.array(discordHistoryMessageSchema),
  nextBefore: discordSnowflakeSchema.nullable(),
});

const discordRepliesResponseSchema = discordHistoryResponseSchema.extend({
  messageId: discordSnowflakeSchema,
  threadId: discordSnowflakeSchema,
});

/** Reads require both the verified Discord user and Okou bot to have access. */
export const integrationsDiscordReadContract = c.router({
  listChannels: {
    method: "GET",
    path: "/api/integrations/discord/channels",
    headers: authHeadersSchema,
    query: discordChannelListQuerySchema,
    responses: {
      200: discordChannelListResponseSchema,
      400: discordNativeErrorSchema,
      401: apiErrorSchema,
      403: discordNativeErrorSchema,
      404: discordNativeErrorSchema,
      429: discordNativeErrorSchema,
      502: discordNativeErrorSchema,
      503: discordNativeErrorSchema,
    },
    summary: "List Discord channels visible to the verified user and bot",
  },
  history: {
    method: "GET",
    path: "/api/integrations/discord/messages",
    headers: authHeadersSchema,
    query: discordHistoryQuerySchema,
    responses: {
      200: discordHistoryResponseSchema,
      400: discordNativeErrorSchema,
      401: apiErrorSchema,
      403: discordNativeErrorSchema,
      404: discordNativeErrorSchema,
      429: discordNativeErrorSchema,
      502: discordNativeErrorSchema,
      503: discordNativeErrorSchema,
    },
    summary: "Read one page of authorized Discord conversation history",
  },
  replies: {
    method: "GET",
    path: "/api/integrations/discord/replies",
    headers: authHeadersSchema,
    query: discordRepliesQuerySchema,
    responses: {
      200: discordRepliesResponseSchema,
      400: discordNativeErrorSchema,
      401: apiErrorSchema,
      403: discordNativeErrorSchema,
      404: discordNativeErrorSchema,
      429: discordNativeErrorSchema,
      502: discordNativeErrorSchema,
      503: discordNativeErrorSchema,
    },
    summary: "Read one page from a Discord message's native thread",
  },
});

export type DiscordChannelListQuery = z.infer<
  typeof discordChannelListQuerySchema
>;
export type DiscordChannelListResponse = z.infer<
  typeof discordChannelListResponseSchema
>;
export type DiscordHistoryQuery = z.infer<typeof discordHistoryQuerySchema>;
export type DiscordHistoryMessage = z.infer<typeof discordHistoryMessageSchema>;
export type DiscordHistoryResponse = z.infer<
  typeof discordHistoryResponseSchema
>;
export type DiscordRepliesQuery = z.infer<typeof discordRepliesQuerySchema>;
export type DiscordRepliesResponse = z.infer<
  typeof discordRepliesResponseSchema
>;
