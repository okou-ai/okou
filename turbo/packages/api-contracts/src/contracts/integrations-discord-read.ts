import {
  array,
  boolean,
  coerce,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { discordSnowflakeSchema } from "../validators/integrations-discord-read";

export { discordSnowflakeSchema } from "../validators/integrations-discord-read";

const c = initContract();

export const discordNativeErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    retryAfterSeconds: number().nonnegative().optional(),
  }),
});

export const discordChannelListQuerySchema = object({
  guildId: discordSnowflakeSchema.optional(),
});

export const discordHistoryQuerySchema = object({
  guildId: discordSnowflakeSchema.optional(),
  channelId: discordSnowflakeSchema,
  before: discordSnowflakeSchema.optional(),
  limit: coerce.number().int().min(1).max(100).default(50),
});

export const discordRepliesQuerySchema = discordHistoryQuerySchema.extend({
  messageId: discordSnowflakeSchema,
});

const discordListedChannelSchema = object({
  id: discordSnowflakeSchema,
  name: string(),
  type: number().int(),
  guildId: discordSnowflakeSchema,
  parentId: discordSnowflakeSchema.nullable(),
});

export const discordHistoryMessageSchema = object({
  id: discordSnowflakeSchema,
  channelId: discordSnowflakeSchema,
  content: string(),
  author: object({
    id: discordSnowflakeSchema,
    username: string(),
    bot: boolean().optional(),
  }),
  timestamp: string(),
  url: string().url(),
  replyTo: object({
    messageId: discordSnowflakeSchema,
    channelId: discordSnowflakeSchema.optional(),
  }).optional(),
  attachments: array(
    object({
      id: discordSnowflakeSchema,
      filename: string(),
      size: number().int().nonnegative(),
      contentType: string().optional(),
    }),
  ),
});

const discordChannelListResponseSchema = object({
  channels: array(discordListedChannelSchema),
});

const discordHistoryResponseSchema = object({
  channelId: discordSnowflakeSchema,
  contextMode: zEnum(["full", "mentions_only"]),
  messages: array(discordHistoryMessageSchema),
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

export type DiscordChannelListQuery = zInfer<
  typeof discordChannelListQuerySchema
>;
export type DiscordChannelListResponse = zInfer<
  typeof discordChannelListResponseSchema
>;
export type DiscordHistoryQuery = zInfer<typeof discordHistoryQuerySchema>;
export type DiscordHistoryMessage = zInfer<typeof discordHistoryMessageSchema>;
export type DiscordHistoryResponse = zInfer<
  typeof discordHistoryResponseSchema
>;
export type DiscordRepliesQuery = zInfer<typeof discordRepliesQuerySchema>;
export type DiscordRepliesResponse = zInfer<
  typeof discordRepliesResponseSchema
>;
