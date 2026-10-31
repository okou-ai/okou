import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  union,
  url,
  uuid,
  enum as zEnum,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { artifactUrlSchema } from "./artifact-references";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { fileDownloadUrlSchema } from "./file-download";

const c = initContract();

const directUploadResponseShape = {
  uploadHeaders: record(string(), string()),
};

/**
 * Integration Slack message contract
 * POST /api/integrations/slack/message
 *
 * Sends a Slack message via the org's installed bot token.
 * Requires `slack:write` capability (via OKOU_TOKEN).
 */
const sendSlackMessageBodySchema = object({
  channel: string().min(1, "Channel ID is required").optional(),
  user: string().min(1, "User ID is required").optional(),
  text: string().optional(),
  threadTs: string().optional(),
  blocks: array(object({ type: string() }).passthrough()).optional(),
}).refine(
  (data) => {
    return Boolean(data.channel) !== Boolean(data.user);
  },
  { message: "Exactly one of 'channel' or 'user' must be provided" },
);

export type SendSlackMessageBody = zInfer<typeof sendSlackMessageBodySchema>;

const sendSlackMessageResponseSchema = object({
  ok: literal(true),
  ts: string().optional(),
  channel: string().optional(),
});

export type SendSlackMessageResponse = zInfer<
  typeof sendSlackMessageResponseSchema
>;

export const integrationsSlackMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/integrations/slack/message",
    headers: authHeadersSchema,
    body: sendSlackMessageBodySchema,
    responses: {
      200: sendSlackMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Send a Slack message via org bot token",
  },
});

export type IntegrationsSlackMessageContract =
  typeof integrationsSlackMessageContract;

/**
 * Integration Feishu message contract
 * POST /api/integrations/feishu/message
 *
 * Sends a Feishu message via an org-owned custom app.
 * Requires `feishu:write` capability (via OKOU_TOKEN).
 */
const feishuCardSchema = record(string(), zUnknown());

const sendFeishuMessageBodySchema = object({
  installationId: uuid().optional(),
  chat: string().min(1, "Chat ID is required").optional(),
  user: string().min(1, "Feishu open ID is required").optional(),
  replyToMessageId: string().min(1, "Message ID is required").optional(),
  replyInThread: boolean().optional(),
  text: string().min(1, "Message text is required").optional(),
  card: feishuCardSchema.optional(),
})
  .refine(
    (body) => {
      return (
        [body.chat, body.user, body.replyToMessageId].filter(Boolean).length ===
        1
      );
    },
    {
      message: "Exactly one of chat, user, or replyToMessageId is required",
      path: ["chat"],
    },
  )
  .refine(
    (body) => {
      return Boolean(body.text) !== Boolean(body.card);
    },
    {
      message: "Exactly one of text or card is required",
      path: ["text"],
    },
  )
  .refine(
    (body) => {
      return !body.replyInThread || Boolean(body.replyToMessageId);
    },
    {
      message: "replyInThread requires replyToMessageId",
      path: ["replyInThread"],
    },
  );

export type SendFeishuMessageBody = zInfer<typeof sendFeishuMessageBodySchema>;

const sendFeishuMessageResponseSchema = object({
  ok: literal(true),
  messageId: string(),
  chatId: string().nullable(),
});

export type SendFeishuMessageResponse = zInfer<
  typeof sendFeishuMessageResponseSchema
>;

export const integrationsFeishuMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/integrations/feishu/message",
    headers: authHeadersSchema,
    body: sendFeishuMessageBodySchema,
    responses: {
      200: sendFeishuMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send a Feishu message via an organization custom app",
  },
});

export type IntegrationsFeishuMessageContract =
  typeof integrationsFeishuMessageContract;

export const FEISHU_FILE_UPLOAD_MAX_BYTES = 30 * 1024 * 1024;

/**
 * Integration Feishu message resource download contract.
 * Requires `feishu:write` because Feishu currently uses one capability for
 * bot-backed messaging and file access.
 */
const feishuResourceTypeSchema = zEnum(["file", "image"]);

export type FeishuResourceType = zInfer<typeof feishuResourceTypeSchema>;

export const integrationsFeishuDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/integrations/feishu/download-file",
    headers: authHeadersSchema,
    query: object({
      installation_id: uuid().optional(),
      message_id: string().min(1, "Message ID is required"),
      file_key: string().min(1, "File key is required"),
      type: feishuResourceTypeSchema,
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: zUnknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a file from a Feishu message",
  },
});

export type IntegrationsFeishuDownloadFileContract =
  typeof integrationsFeishuDownloadFileContract;

/**
 * Integration Feishu file upload — init contract.
 *
 * The CLI uploads to temporary storage before the API forwards the bytes
 * to Feishu with the organization bot's tenant token.
 */
const feishuUploadInitBodySchema = object({
  filename: string().min(1, "Filename is required").max(255),
  contentType: string().min(1, "Content type is required").max(200),
  length: number()
    .int()
    .positive("File length must be a positive integer")
    .max(
      FEISHU_FILE_UPLOAD_MAX_BYTES,
      `File must not exceed ${FEISHU_FILE_UPLOAD_MAX_BYTES} bytes`,
    ),
});

export type FeishuUploadInitBody = zInfer<typeof feishuUploadInitBodySchema>;

const feishuUploadInitResponseSchema = object({
  uploadId: uuid(),
  uploadUrl: string(),
  fileUrl: string(),
  filename: string(),
  contentType: string(),
  size: number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type FeishuUploadInitResponse = zInfer<
  typeof feishuUploadInitResponseSchema
>;

export const integrationsFeishuUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/feishu/upload-file/init",
    headers: authHeadersSchema,
    body: feishuUploadInitBodySchema,
    responses: {
      200: feishuUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for Feishu file delivery",
  },
});

/**
 * Integration Feishu file upload — complete contract.
 *
 * Uploads the stored bytes to Feishu and sends the resulting file key to one
 * chat, user, or reply target.
 */
const feishuUploadCompleteBodySchema = object({
  uploadId: string().check(uuid("Upload ID must be a UUID")),
  installationId: uuid().optional(),
  chat: string().min(1, "Chat ID is required").optional(),
  user: string().min(1, "Feishu open ID is required").optional(),
  replyToMessageId: string().min(1, "Message ID is required").optional(),
  replyInThread: boolean().optional(),
  contentType: string().min(1).max(200).optional(),
})
  .refine(
    (body) => {
      return (
        [body.chat, body.user, body.replyToMessageId].filter(Boolean).length ===
        1
      );
    },
    {
      message: "Exactly one of chat, user, or replyToMessageId is required",
      path: ["chat"],
    },
  )
  .refine(
    (body) => {
      return !body.replyInThread || Boolean(body.replyToMessageId);
    },
    {
      message: "replyInThread requires replyToMessageId",
      path: ["replyInThread"],
    },
  );

export type FeishuUploadCompleteBody = zInfer<
  typeof feishuUploadCompleteBodySchema
>;

const feishuUploadCompleteResponseSchema = object({
  messageId: string(),
  chatId: string().nullable(),
  fileKey: string(),
  filename: string(),
  mimetype: string(),
  size: number().int().nonnegative(),
  url: string(),
});

export type FeishuUploadCompleteResponse = zInfer<
  typeof feishuUploadCompleteResponseSchema
>;

export const integrationsFeishuUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/feishu/upload-file/complete",
    headers: authHeadersSchema,
    body: feishuUploadCompleteBodySchema,
    responses: {
      200: feishuUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Finalize Feishu file upload and send it to a conversation",
  },
});

/**
 * Integration Telegram message contract
 * POST /api/integrations/telegram/message
 *
 * Sends a Telegram message through the official shared Okou bot.
 * `chatId` may be `"me"` to target the caller's private chat with the bot
 * (resolved from the caller's official Telegram link in the current org); the response
 * `chatId` is the resolved chat.
 * Requires `telegram:write` capability (via OKOU_TOKEN).
 */
const sendTelegramMessageBodySchema = object({
  botId: string().min(1, "Bot ID is required"),
  /** Telegram chat ID, or `"me"` for the caller's private chat with the bot. */
  chatId: string().min(1, "Chat ID is required"),
  text: string().min(1, "Message text is required"),
  replyToMessageId: number().int().positive().optional(),
  messageThreadId: number().int().positive().optional(),
});

export type SendTelegramMessageBody = zInfer<
  typeof sendTelegramMessageBodySchema
>;

const sendTelegramMessageResponseSchema = object({
  ok: literal(true),
  messageId: number().int(),
  chatId: string(),
});

export type SendTelegramMessageResponse = zInfer<
  typeof sendTelegramMessageResponseSchema
>;

export const integrationsTelegramMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/integrations/telegram/message",
    headers: authHeadersSchema,
    body: sendTelegramMessageBodySchema,
    responses: {
      200: sendTelegramMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send a Telegram message through the official Okou bot",
  },
});

export type IntegrationsTelegramMessageContract =
  typeof integrationsTelegramMessageContract;

/**
 * Integration Microsoft Teams message contract
 * POST /api/integrations/teams/message
 *
 * Sends a Microsoft Teams message via the org's installed Teams bot.
 * Requires `teams:write` capability (via OKOU_TOKEN).
 */
const teamsAdaptiveCardSchema = object({
  type: literal("AdaptiveCard"),
  version: string().min(1),
  body: array(record(string(), zUnknown())).optional(),
  actions: array(record(string(), zUnknown())).optional(),
}).passthrough();

const sendTeamsMessageBodySchema = object({
  conversationId: string().min(1, "Conversation ID is required").optional(),
  user: string().min(1, "Teams user ID is required").optional(),
  text: string().min(1, "Message text is required").optional(),
  activityId: string().min(1, "Activity ID is required").optional(),
  card: teamsAdaptiveCardSchema.optional(),
})
  .refine(
    (body) => {
      return Boolean(body.conversationId) !== Boolean(body.user);
    },
    {
      message: "Exactly one of conversationId or user is required",
      path: ["conversationId"],
    },
  )
  .refine(
    (body) => {
      return Boolean(body.text) || Boolean(body.card);
    },
    {
      message: "Message text or card is required",
      path: ["text"],
    },
  )
  .refine(
    (body) => {
      return !(body.user && body.activityId);
    },
    {
      message: "activityId can only be used with conversationId",
      path: ["activityId"],
    },
  );

export type SendTeamsMessageBody = zInfer<typeof sendTeamsMessageBodySchema>;

const sendTeamsMessageResponseSchema = object({
  ok: literal(true),
  activityId: string().optional(),
  conversationId: string(),
});

export type SendTeamsMessageResponse = zInfer<
  typeof sendTeamsMessageResponseSchema
>;

export const integrationsTeamsMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/integrations/teams/message",
    headers: authHeadersSchema,
    body: sendTeamsMessageBodySchema,
    responses: {
      200: sendTeamsMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send a Microsoft Teams message via org bot",
  },
});

export type IntegrationsTeamsMessageContract =
  typeof integrationsTeamsMessageContract;

/**
 * Integration AgentPhone message contract
 * POST /api/integrations/phone/message
 *
 * Sends an AgentPhone text message to the caller's own linked phone handle.
 * Requires `phone:write` capability (via OKOU_TOKEN).
 */
const sendPhoneMessageBodySchema = object({
  agentphoneAgentId: string().min(1, "Phone agent ID is required").optional(),
  text: string().min(1, "Message text is required"),
});

export type SendPhoneMessageBody = zInfer<typeof sendPhoneMessageBodySchema>;

const sendPhoneMessageResponseSchema = object({
  ok: literal(true),
  messageId: string(),
  channel: string().nullable(),
  toNumber: string(),
});

export type SendPhoneMessageResponse = zInfer<
  typeof sendPhoneMessageResponseSchema
>;

const sendPhoneReactionBodySchema = object({
  messageId: string().trim().min(1).max(255),
  reaction: string().trim().min(1).max(64),
});

export type SendPhoneReactionBody = zInfer<typeof sendPhoneReactionBodySchema>;

export const integrationsPhoneMessageContract = c.router({
  sendMessage: {
    method: "POST",
    path: "/api/integrations/phone/message",
    headers: authHeadersSchema,
    body: sendPhoneMessageBodySchema,
    responses: {
      200: sendPhoneMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send a phone message",
  },
  sendReaction: {
    method: "POST",
    path: "/api/integrations/phone/reaction",
    headers: authHeadersSchema,
    body: sendPhoneReactionBodySchema,
    responses: {
      200: object({
        ok: literal(true),
        reactionId: string(),
        messageId: string(),
        reaction: string(),
        channel: literal("imessage"),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "React to an iMessage visible to the caller",
  },
});

export type IntegrationsPhoneMessageContract =
  typeof integrationsPhoneMessageContract;

const phoneDownloadFileQuerySchema = object({
  file_id: string().min(1, "file_id query parameter is required"),
});

export const integrationsPhoneDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/integrations/phone/download-file",
    headers: authHeadersSchema,
    query: phoneDownloadFileQuerySchema,
    responses: {
      200: c.type<Blob>(),
      302: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a phone media attachment",
  },
});

export type IntegrationsPhoneDownloadFileContract =
  typeof integrationsPhoneDownloadFileContract;

/**
 * Integration Telegram bot list contract
 * GET /api/integrations/telegram/bots
 *
 * Reports the official Telegram bot for older CLI clients.
 * Requires `telegram:read` capability (via OKOU_TOKEN).
 */
const telegramBotTokenStatusSchema = zEnum(["valid", "invalid", "unknown"]);

const telegramConnectedUserSchema = object({
  telegramUserId: string(),
  telegramUsername: string().nullable(),
  telegramDisplayName: string().nullable(),
});

const telegramBotListItemSchema = object({
  id: string(),
  kind: literal("official").optional(),
  username: string().nullable(),
  agent: object({ id: string(), name: string() }).nullable(),
  isOwner: boolean(),
  isConnected: boolean(),
  connectedUser: telegramConnectedUserSchema.nullable().optional(),
  tokenStatus: telegramBotTokenStatusSchema,
  official: object({
    configured: boolean(),
    usesDefaultAgent: boolean(),
    linkedTelegramUserId: string().nullable(),
  }).optional(),
});

const listTelegramBotsResponseSchema = object({
  bots: array(telegramBotListItemSchema),
});

export type TelegramBotListItem = zInfer<typeof telegramBotListItemSchema>;
export type ListTelegramBotsResponse = zInfer<
  typeof listTelegramBotsResponseSchema
>;

export const integrationsTelegramBotListContract = c.router({
  listBots: {
    method: "GET",
    path: "/api/integrations/telegram/bots",
    headers: authHeadersSchema,
    responses: {
      200: listTelegramBotsResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get the official Telegram bot status",
  },
});

export type IntegrationsTelegramBotListContract =
  typeof integrationsTelegramBotListContract;

/**
 * Integration Slack file download contract.
 * Requires `slack:write` because Slack's file APIs are reached through the
 * org bot token that also posts messages.
 */
export const integrationsSlackDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/integrations/slack/download-file",
    headers: authHeadersSchema,
    query: object({
      file_id: string().optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: zUnknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a Slack file via org bot token",
  },
});

export type IntegrationsSlackDownloadFileContract =
  typeof integrationsSlackDownloadFileContract;

/**
 * Integration Slack file upload — init contract
 * POST /api/integrations/slack/upload-file/init
 *
 * Requests a pre-signed upload URL from Slack via the org's bot token.
 * The CLI then uploads the file directly to that URL (no auth needed).
 * A canonical destination names exactly one of `channel` or `user` (a Slack
 * user ID or `"me"`); a user is resolved to a DM channel, which is persisted
 * and returned as `channel`.
 * Requires `slack:write` capability (via OKOU_TOKEN).
 */
const slackUploadInitBodySchema = object({
  filename: string().min(1, "Filename is required"),
  length: number().int().positive("File length must be a positive integer"),
  canonical: object({
    operationId: uuid(),
    contentType: string().min(1).max(200),
    checksumSha256: string().regex(/^[a-f0-9]{64}$/),
    channel: string().min(1, "Channel ID is required").optional(),
    user: string().min(1, "User ID is required").optional(),
    threadTs: string().optional(),
    title: string().optional(),
    initialComment: string().optional(),
  })
    .refine(
      (data) => {
        return Boolean(data.channel) !== Boolean(data.user);
      },
      { message: "Exactly one of 'channel' or 'user' must be provided" },
    )
    .optional(),
});

export type SlackUploadInitBody = zInfer<typeof slackUploadInitBodySchema>;

const directSlackUploadInitResponseSchema = object({
  uploadUrl: string(),
  fileId: string(),
});

const canonicalSlackUploadInitResponseSchema = object({
  kind: literal("canonical"),
  assetId: uuid(),
  operationId: uuid(),
  /** Resolved destination channel ID (a DM channel when `user` was sent). */
  channel: string(),
  uploadUrl: url().optional(),
  uploadHeaders: record(string(), string()).optional(),
  url: artifactUrlSchema,
});

const slackUploadInitResponseSchema = union([
  directSlackUploadInitResponseSchema,
  canonicalSlackUploadInitResponseSchema,
]);

export type SlackUploadInitResponse = zInfer<
  typeof slackUploadInitResponseSchema
>;

export const integrationsSlackUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/slack/upload-file/init",
    headers: authHeadersSchema,
    body: slackUploadInitBodySchema,
    responses: {
      200: slackUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Get a pre-signed Slack upload URL via org bot token",
  },
});

const slackUploadMaterializeBodySchema = object({
  assetId: uuid(),
  operationId: uuid(),
});

const slackUploadMaterializeResponseSchema = object({
  assetId: uuid(),
  url: artifactUrlSchema,
  delivery: discriminatedUnion("status", [
    object({
      status: literal("pending"),
      uploadUrl: string(),
      fileId: string(),
    }),
    object({
      status: literal("delivered"),
      fileId: string(),
      permalink: string(),
    }),
    object({
      status: literal("failed"),
      message: string(),
      retryable: boolean(),
    }),
  ]),
});

export type SlackUploadMaterializeBody = zInfer<
  typeof slackUploadMaterializeBodySchema
>;
export type SlackUploadMaterializeResponse = zInfer<
  typeof slackUploadMaterializeResponseSchema
>;

export const integrationsSlackUploadMaterializeContract = c.router({
  materialize: {
    method: "POST",
    path: "/api/integrations/slack/upload-file/materialize",
    headers: authHeadersSchema,
    body: slackUploadMaterializeBodySchema,
    responses: {
      200: slackUploadMaterializeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Materialize a canonical Slack publication before delivery",
  },
});

/**
 * Integration Telegram file download contract.
 * Requires `telegram:read`: the bot token it resolves belongs to the org
 * installation named by `bot_id`.
 */
export const integrationsTelegramDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/integrations/telegram/download-file",
    headers: authHeadersSchema,
    query: object({
      file_id: string().min(1),
      bot_id: string().min(1),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: zUnknown(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a Telegram file via org bot token",
  },
});

export type IntegrationsTelegramDownloadFileContract =
  typeof integrationsTelegramDownloadFileContract;

/**
 * Integration Telegram file upload — init contract
 * POST /api/integrations/telegram/upload-file/init
 *
 * Requests a pre-signed upload URL for a temporary hosted file. The CLI
 * uploads the file body directly to R2, then the complete route asks Telegram
 * to fetch that file URL with the org-owned bot token.
 * Requires `telegram:write` capability (via OKOU_TOKEN).
 */
const telegramUploadInitBodySchema = object({
  filename: string().min(1, "Filename is required").max(255),
  contentType: string().min(1, "Content type is required").max(200),
  length: number().int().positive("File length must be a positive integer"),
});

export type TelegramUploadInitBody = zInfer<
  typeof telegramUploadInitBodySchema
>;

const telegramUploadInitResponseSchema = object({
  uploadId: uuid(),
  uploadUrl: string(),
  fileUrl: string(),
  filename: string(),
  contentType: string(),
  size: number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type TelegramUploadInitResponse = zInfer<
  typeof telegramUploadInitResponseSchema
>;

export const integrationsTelegramUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/telegram/upload-file/init",
    headers: authHeadersSchema,
    body: telegramUploadInitBodySchema,
    responses: {
      200: telegramUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for Telegram file delivery",
  },
});

/**
 * Integration Microsoft Teams file download contract.
 * Requires `teams:write` because Teams currently uses one capability for
 * bot-backed messaging and file access.
 */
export const integrationsTeamsDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/integrations/teams/download-file",
    headers: authHeadersSchema,
    query: object({
      file_id: string().optional(),
    }),
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: zUnknown(),
      }),
      302: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Download a Microsoft Teams file from a signed file id",
  },
});

export type IntegrationsTeamsDownloadFileContract =
  typeof integrationsTeamsDownloadFileContract;

/**
 * Integration Microsoft Teams file upload — init contract
 * POST /api/integrations/teams/upload-file/init
 *
 * Requests a pre-signed upload URL for a temporary hosted file. The CLI
 * uploads the file body directly to R2, then the complete route sends a Teams
 * message with the file attachment and public file URL.
 * Requires `teams:write` capability (via OKOU_TOKEN).
 */
const teamsUploadInitBodySchema = object({
  canonical: object({
    operationId: uuid(),
    checksumSha256: string().regex(/^[a-f0-9]{64}$/u),
    conversationId: string().min(1).optional(),
    user: string().min(1).optional(),
    activityId: string().min(1).optional(),
    text: string().max(4000).optional(),
  })
    .refine(
      (value) => {
        return Boolean(value.conversationId) !== Boolean(value.user);
      },
      {
        message: "Exactly one of conversationId or user is required",
      },
    )
    .refine(
      (value) => {
        return !(value.user && value.activityId);
      },
      {
        message: "activityId can only be used with conversationId",
      },
    )
    .optional(),
  filename: string().min(1, "Filename is required").max(255),
  contentType: string().min(1, "Content type is required").max(200),
  length: number().int().positive("File length must be a positive integer"),
});

export type TeamsUploadInitBody = zInfer<typeof teamsUploadInitBodySchema>;

const teamsUploadInitResponseSchema = object({
  operationId: uuid().optional(),
  uploadRequired: boolean().optional(),
  uploadId: uuid(),
  uploadUrl: string(),
  fileUrl: string(),
  filename: string(),
  contentType: string(),
  size: number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type TeamsUploadInitResponse = zInfer<
  typeof teamsUploadInitResponseSchema
>;

export const integrationsTeamsUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/teams/upload-file/init",
    headers: authHeadersSchema,
    body: teamsUploadInitBodySchema,
    responses: {
      200: teamsUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for Microsoft Teams file delivery",
  },
});

/**
 * Integration Telegram file upload — complete contract
 * POST /api/integrations/telegram/upload-file/complete
 *
 * Sends an uploaded file URL to a Telegram chat via sendDocument using the
 * official shared Okou bot token. `chatId` may be `"me"` to target the
 * caller's private chat with the bot; the response `chatId` is the resolved
 * chat.
 * Requires `telegram:write` capability (via OKOU_TOKEN).
 */
const telegramUploadCompleteBodySchema = object({
  uploadId: string().check(uuid("Upload ID must be a UUID")),
  botId: string().min(1, "Bot ID is required"),
  /** Telegram chat ID, or `"me"` for the caller's private chat with the bot. */
  chatId: string().min(1, "Chat ID is required"),
  contentType: string().min(1).max(200).optional(),
  caption: string().max(1024).optional(),
  messageThreadId: number().int().positive().optional(),
});

export type TelegramUploadCompleteBody = zInfer<
  typeof telegramUploadCompleteBodySchema
>;

const telegramUploadCompleteResponseSchema = object({
  messageId: number().int(),
  chatId: string(),
  fileId: string().optional(),
  filename: string(),
  mimetype: string(),
  size: number().int().nonnegative(),
  url: string(),
});

export type TelegramUploadCompleteResponse = zInfer<
  typeof telegramUploadCompleteResponseSchema
>;

export const integrationsTelegramUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/telegram/upload-file/complete",
    headers: authHeadersSchema,
    body: telegramUploadCompleteBodySchema,
    responses: {
      200: telegramUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Finalize Telegram file upload and send it to a chat",
  },
});

/**
 * Integration Microsoft Teams file upload — complete contract
 * POST /api/integrations/teams/upload-file/complete
 *
 * Sends an uploaded file URL to a Microsoft Teams conversation using the org's
 * installed Teams bot. The target is exactly one of `conversationId` or `user`
 * (a Teams user ID or `"me"`, resolved to a personal conversation); the
 * response `conversationId` is the resolved conversation.
 * Requires `teams:write` capability (via OKOU_TOKEN).
 */
const teamsUploadCompleteBodySchema = object({
  operationId: uuid().optional(),
  uploadId: string().check(uuid("Upload ID must be a UUID")),
  conversationId: string().min(1, "Conversation ID is required").optional(),
  user: string().min(1, "Teams user ID is required").optional(),
  activityId: string().min(1, "Activity ID is required").optional(),
  contentType: string().min(1).max(200).optional(),
  text: string().max(4000).optional(),
})
  .refine(
    (body) => {
      return Boolean(body.conversationId) !== Boolean(body.user);
    },
    {
      message: "Exactly one of conversationId or user is required",
      path: ["conversationId"],
    },
  )
  .refine(
    (body) => {
      return !(body.user && body.activityId);
    },
    {
      message: "activityId can only be used with conversationId",
      path: ["activityId"],
    },
  );

export type TeamsUploadCompleteBody = zInfer<
  typeof teamsUploadCompleteBodySchema
>;

const teamsUploadCompleteResponseSchema = object({
  activityId: string().optional(),
  conversationId: string(),
  filename: string(),
  mimetype: string(),
  size: number().int().nonnegative(),
  url: string(),
});

export type TeamsUploadCompleteResponse = zInfer<
  typeof teamsUploadCompleteResponseSchema
>;

export const integrationsTeamsUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/teams/upload-file/complete",
    headers: authHeadersSchema,
    body: teamsUploadCompleteBodySchema,
    responses: {
      200: teamsUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary:
      "Finalize Microsoft Teams file upload and send it to a conversation",
  },
});

/**
 * Integration GitHub file download contract.
 * Requires `github:read`: the URL is fetched anonymously, so the capability
 * gates who may ask the API to reach a GitHub attachment host at all.
 */
export const integrationsGithubDownloadFileContract = c.router({
  fileUrl: {
    method: "GET",
    path: "/api/integrations/github/download-file/url",
    headers: authHeadersSchema,
    query: object({
      url: string().check(url("url must be a GitHub file URL")),
      filename: string().min(1).max(255).optional(),
    }),
    responses: {
      200: fileDownloadUrlSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      413: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Resolve a GitHub context file download URL",
  },
});

export type IntegrationsGithubDownloadFileContract =
  typeof integrationsGithubDownloadFileContract;

/**
 * Integration GitHub file upload — init contract
 * POST /api/integrations/github/upload-file/init
 *
 * Requests a pre-signed upload URL for a temporary hosted file. The CLI
 * uploads the file body directly to R2, then the complete route posts the file
 * URL back to a GitHub issue or pull request comment.
 * Requires `github:write` capability (via OKOU_TOKEN).
 */
const githubUploadInitBodySchema = object({
  filename: string().min(1, "Filename is required").max(255),
  contentType: string().min(1, "Content type is required").max(200),
  length: number().int().positive("File length must be a positive integer"),
});

export type GithubUploadInitBody = zInfer<typeof githubUploadInitBodySchema>;

const githubUploadInitResponseSchema = object({
  uploadId: uuid(),
  uploadUrl: string(),
  fileUrl: string(),
  filename: string(),
  contentType: string(),
  size: number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type GithubUploadInitResponse = zInfer<
  typeof githubUploadInitResponseSchema
>;

export const integrationsGithubUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/github/upload-file/init",
    headers: authHeadersSchema,
    body: githubUploadInitBodySchema,
    responses: {
      200: githubUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for GitHub file delivery",
  },
});

/**
 * Integration GitHub file upload — complete contract
 * POST /api/integrations/github/upload-file/complete
 *
 * Posts an uploaded file URL to a GitHub issue or pull request comment using
 * the organization GitHub App installation token.
 * Requires `github:write` capability (via OKOU_TOKEN).
 */
const githubUploadCompleteBodySchema = object({
  uploadId: string().check(uuid("Upload ID must be a UUID")),
  repo: string()
    .min(1, "Repository is required")
    .regex(/^[^/\s]+\/[^/\s]+$/, "Repository must be owner/name"),
  issueNumber: number()
    .int()
    .positive("Issue or pull request number must be positive"),
  contentType: string().min(1).max(200).optional(),
  caption: string().max(65_536).optional(),
});

export type GithubUploadCompleteBody = zInfer<
  typeof githubUploadCompleteBodySchema
>;

const githubUploadCompleteResponseSchema = object({
  commentId: string(),
  repo: string(),
  issueNumber: number().int(),
  filename: string(),
  mimetype: string(),
  size: number().int().nonnegative(),
  url: string(),
});

export type GithubUploadCompleteResponse = zInfer<
  typeof githubUploadCompleteResponseSchema
>;

export const integrationsGithubUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/github/upload-file/complete",
    headers: authHeadersSchema,
    body: githubUploadCompleteBodySchema,
    responses: {
      200: githubUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Finalize GitHub file upload and post it to an issue or PR",
  },
});

/**
 * Integration AgentPhone file upload — init contract
 * POST /api/integrations/phone/upload-file/init
 *
 * Requests a pre-signed upload URL for a hosted file. The CLI uploads the
 * file body directly to R2, then complete sends the public file URL through
 * AgentPhone.
 * Requires `phone:write` capability (via OKOU_TOKEN).
 */
const phoneUploadInitBodySchema = object({
  filename: string().min(1, "Filename is required").max(255),
  contentType: string().min(1, "Content type is required").max(200),
  length: number().int().positive("File length must be a positive integer"),
});

export type PhoneUploadInitBody = zInfer<typeof phoneUploadInitBodySchema>;

const phoneUploadInitResponseSchema = object({
  uploadId: uuid(),
  uploadUrl: string(),
  fileUrl: string(),
  filename: string(),
  contentType: string(),
  size: number().int().nonnegative(),
  ...directUploadResponseShape,
});

export type PhoneUploadInitResponse = zInfer<
  typeof phoneUploadInitResponseSchema
>;

export const integrationsPhoneUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/phone/upload-file/init",
    headers: authHeadersSchema,
    body: phoneUploadInitBodySchema,
    responses: {
      200: phoneUploadInitResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Get a pre-signed upload URL for phone file delivery",
  },
});

/**
 * Integration AgentPhone file upload — complete contract
 * POST /api/integrations/phone/upload-file/complete
 *
 * Sends an uploaded file URL to the caller's own linked phone handle through
 * AgentPhone. Requires `phone:write` capability (via OKOU_TOKEN).
 */
const phoneUploadCompleteBodySchema = object({
  uploadId: string().check(uuid("Upload ID must be a UUID")),
  agentphoneAgentId: string().min(1, "Phone agent ID is required").optional(),
  contentType: string().min(1).max(200).optional(),
  caption: string().max(1024).optional(),
});

const phoneGroupUploadCompleteBodySchema = phoneUploadCompleteBodySchema.extend(
  {
    groupId: string().min(5).max(255).startsWith("grp_"),
  },
);

export type PhoneUploadCompleteBody = zInfer<
  typeof phoneUploadCompleteBodySchema
>;

const phoneUploadCompleteResponseSchema = object({
  messageId: string(),
  channel: string().nullable(),
  toNumber: string(),
  filename: string(),
  mimetype: string(),
  size: number().int().nonnegative(),
  url: string(),
});

export type PhoneUploadCompleteResponse = zInfer<
  typeof phoneUploadCompleteResponseSchema
>;

export const integrationsPhoneUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/phone/upload-file/complete",
    headers: authHeadersSchema,
    body: phoneUploadCompleteBodySchema,
    responses: {
      200: phoneUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Finalize phone file upload and send it to a phone handle",
  },
  completeGroup: {
    method: "POST",
    path: "/api/integrations/phone/upload-file/complete-group",
    headers: authHeadersSchema,
    body: phoneGroupUploadCompleteBodySchema,
    responses: {
      200: phoneUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      502: apiErrorSchema,
    },
    summary: "Send an uploaded file to an iMessage group the caller belongs to",
  },
});

/**
 * Integration Slack file upload — complete contract
 * POST /api/integrations/slack/upload-file/complete
 *
 * Finalizes a Slack file upload and shares it to a channel/thread.
 * Direct completions name exactly one of `channel` or `user` (a Slack user ID
 * or `"me"`, resolved to a DM channel). Canonical completions deliver to the
 * destination persisted at init and ignore `channel`/`user`.
 * Requires `slack:write` capability (via OKOU_TOKEN).
 */
const slackUploadCompleteBodySchema = object({
  fileId: string().min(1, "File ID is required"),
  channel: string().min(1, "Channel ID is required").optional(),
  user: string().min(1, "User ID is required").optional(),
  threadTs: string().optional(),
  title: string().optional(),
  initialComment: string().optional(),
  canonicalAssetId: uuid().optional(),
  operationId: uuid().optional(),
  uploadError: string().max(2000).optional(),
}).refine(
  (data) => {
    return Boolean(data.channel) !== Boolean(data.user);
  },
  { message: "Exactly one of 'channel' or 'user' must be provided" },
);

export type SlackUploadCompleteBody = zInfer<
  typeof slackUploadCompleteBodySchema
>;

const slackUploadCompleteResponseSchema = object({
  fileId: string(),
  permalink: string(),
  /** Channel ID the file was shared to (a DM channel when `user` was sent). */
  channel: string(),
  assetId: uuid().optional(),
  assetUrl: url().optional(),
  deliveryStatus: zEnum(["delivered", "failed"]).optional(),
  deliveryError: string().optional(),
});

export type SlackUploadCompleteResponse = zInfer<
  typeof slackUploadCompleteResponseSchema
>;

export const integrationsSlackUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/slack/upload-file/complete",
    headers: authHeadersSchema,
    body: slackUploadCompleteBodySchema,
    responses: {
      200: slackUploadCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Finalize Slack file upload and share to channel",
  },
});

// Lark uses separate endpoints so older APIs fail closed instead of routing to Feishu.
export const integrationsLarkMessageContract = c.router({
  sendMessage: {
    ...integrationsFeishuMessageContract.sendMessage,
    summary: integrationsFeishuMessageContract.sendMessage.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/message",
  },
});
export const integrationsLarkDownloadFileContract = c.router({
  download: {
    ...integrationsFeishuDownloadFileContract.download,
    summary: integrationsFeishuDownloadFileContract.download.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/download-file",
  },
});
export const integrationsLarkUploadInitContract = c.router({
  init: {
    ...integrationsFeishuUploadInitContract.init,
    summary: integrationsFeishuUploadInitContract.init.summary.replaceAll(
      "Feishu",
      "Lark",
    ),
    path: "/api/integrations/lark/upload-file/init",
  },
});
export const integrationsLarkUploadCompleteContract = c.router({
  complete: {
    ...integrationsFeishuUploadCompleteContract.complete,
    summary:
      integrationsFeishuUploadCompleteContract.complete.summary.replaceAll(
        "Feishu",
        "Lark",
      ),
    path: "/api/integrations/lark/upload-file/complete",
  },
});
