import {
  array,
  boolean,
  coerce,
  looseObject,
  number,
  object,
  string,
  url,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const timestampSchema = string().regex(/^\d+(?:\.\d{1,6})?$/);

const slackReadErrorSchema = apiErrorSchema.extend({
  error: apiErrorSchema.shape.error.extend({
    channelUrl: url().optional(),
    retryAfterSeconds: number().int().nonnegative().optional(),
  }),
});

export const slackChannelListQuerySchema = object({
  limit: coerce.number().int().min(1).max(200).default(100),
  cursor: string().min(1).optional(),
});

export const slackHistoryQuerySchema = object({
  channel: string().regex(/^[CGD][A-Z0-9]+$/),
  limit: coerce.number().int().min(1).max(200).default(15),
  cursor: string().min(1).optional(),
  oldest: timestampSchema.optional(),
  latest: timestampSchema.optional(),
}).refine(
  (query) => {
    return (
      query.oldest === undefined ||
      query.latest === undefined ||
      Number(query.oldest) < Number(query.latest)
    );
  },
  { message: "oldest must be earlier than latest", path: ["oldest"] },
);

const slackListedChannelSchema = object({
  id: string(),
  name: string(),
  isPrivate: boolean(),
  isMember: boolean(),
  channelUrl: url(),
});

export const slackRepliesQuerySchema = slackHistoryQuerySchema.safeExtend({
  thread: timestampSchema,
});

// Preserve Slack's message variants, including blocks, files and attachments.
export const slackHistoryMessageSchema = looseObject({
  type: string(),
  ts: string(),
  text: string().optional(),
  user: string().optional(),
  bot_id: string().optional(),
  subtype: string().optional(),
  thread_ts: string().optional(),
  reply_count: number().int().nonnegative().optional(),
});

const slackChannelListResponseSchema = object({
  channels: array(slackListedChannelSchema),
  nextCursor: string().nullable(),
});

const slackHistoryResponseSchema = object({
  channel: string(),
  channelUrl: url(),
  messages: array(slackHistoryMessageSchema),
  hasMore: boolean(),
  nextCursor: string().nullable(),
});

const slackRepliesResponseSchema = slackHistoryResponseSchema.extend({
  thread: string(),
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

export type SlackChannelListQuery = zInfer<typeof slackChannelListQuerySchema>;
export type SlackHistoryQuery = zInfer<typeof slackHistoryQuerySchema>;
export type SlackChannelListResponse = zInfer<
  typeof slackChannelListResponseSchema
>;
export type SlackHistoryResponse = zInfer<typeof slackHistoryResponseSchema>;
export type SlackRepliesQuery = zInfer<typeof slackRepliesQuerySchema>;
export type SlackRepliesResponse = zInfer<typeof slackRepliesResponseSchema>;
