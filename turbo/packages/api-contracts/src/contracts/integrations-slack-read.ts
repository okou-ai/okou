import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const timestampSchema = z.string().regex(/^\d+(?:\.\d{1,6})?$/);

const slackReadErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    channelUrl: z.string().url().optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});

export const slackChannelListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).optional(),
});

export const slackHistoryQuerySchema = z
  .object({
    channel: z.string().regex(/^[CGD][A-Z0-9]+$/),
    limit: z.coerce.number().int().min(1).max(200).default(15),
    cursor: z.string().min(1).optional(),
    oldest: timestampSchema.optional(),
    latest: timestampSchema.optional(),
  })
  .refine(
    (query) => {
      return (
        query.oldest === undefined ||
        query.latest === undefined ||
        Number(query.oldest) < Number(query.latest)
      );
    },
    { message: "oldest must be earlier than latest", path: ["oldest"] },
  );

const slackListedChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
  isMember: z.boolean(),
  channelUrl: z.string().url(),
});

export const slackRepliesQuerySchema = slackHistoryQuerySchema.safeExtend({
  thread: timestampSchema,
});

// Preserve Slack's message variants, including blocks, files and attachments.
export const slackHistoryMessageSchema = z.looseObject({
  type: z.string(),
  ts: z.string(),
  text: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
  thread_ts: z.string().optional(),
  reply_count: z.number().int().nonnegative().optional(),
});

const slackChannelListResponseSchema = z.object({
  channels: z.array(slackListedChannelSchema),
  nextCursor: z.string().nullable(),
});

const slackHistoryResponseSchema = z.object({
  channel: z.string(),
  channelUrl: z.string().url(),
  messages: z.array(slackHistoryMessageSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

const slackRepliesResponseSchema = slackHistoryResponseSchema.extend({
  thread: z.string(),
});

/** Reads shared by the connected Slack user and organization bot. */
export const integrationsSlackReadContract = c.router({
  listChannels: {
    method: "GET",
    path: "/api/integrations/slack/channels",
    headers: authHeadersSchema,
    query: slackChannelListQuerySchema,
    responses: {
      200: slackChannelListResponseSchema,
      400: slackReadErrorSchema,
      401: apiErrorSchema,
      403: slackReadErrorSchema,
      404: slackReadErrorSchema,
      429: slackReadErrorSchema,
      502: slackReadErrorSchema,
    },
    summary: "List channels shared by the connected Slack user and bot",
  },
  history: {
    method: "GET",
    path: "/api/integrations/slack/history",
    headers: authHeadersSchema,
    query: slackHistoryQuerySchema,
    responses: {
      200: slackHistoryResponseSchema,
      400: slackReadErrorSchema,
      401: apiErrorSchema,
      403: slackReadErrorSchema,
      404: slackReadErrorSchema,
      429: slackReadErrorSchema,
      502: slackReadErrorSchema,
    },
    summary: "Read shared channel or bot direct-message history",
  },
  replies: {
    method: "GET",
    path: "/api/integrations/slack/replies",
    headers: authHeadersSchema,
    query: slackRepliesQuerySchema,
    responses: {
      200: slackRepliesResponseSchema,
      400: slackReadErrorSchema,
      401: apiErrorSchema,
      403: slackReadErrorSchema,
      404: slackReadErrorSchema,
      429: slackReadErrorSchema,
      502: slackReadErrorSchema,
    },
    summary:
      "Read one thread page, including the parent when returned by Slack",
  },
});

export type SlackChannelListQuery = z.infer<typeof slackChannelListQuerySchema>;
export type SlackHistoryQuery = z.infer<typeof slackHistoryQuerySchema>;
export type SlackChannelListResponse = z.infer<
  typeof slackChannelListResponseSchema
>;
export type SlackHistoryResponse = z.infer<typeof slackHistoryResponseSchema>;
export type SlackRepliesQuery = z.infer<typeof slackRepliesQuerySchema>;
export type SlackRepliesResponse = z.infer<typeof slackRepliesResponseSchema>;
