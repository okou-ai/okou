import {
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
  type infer as zInfer,
} from "zod";

import { artifactUrlSchema } from "./artifact-references";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { fileDownloadUrlSchema } from "./file-download";
import { discordSnowflakeSchema } from "./integrations-discord-read";

export const MAX_DISCORD_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const discordFilenameSchema = string()
  .min(1)
  .max(255)
  .refine((filename) => {
    return (
      filename !== "." &&
      filename !== ".." &&
      !/[\\/]/u.test(filename) &&
      !/\p{Cc}/u.test(filename)
    );
  }, "Filename must not contain path separators or control characters");

const discordUploadInitBodySchema = object({
  filename: discordFilenameSchema,
  length: number().int().positive().max(MAX_DISCORD_FILE_SIZE_BYTES),
  contentType: string().min(1).max(255),
  checksumSha256: string().regex(/^[a-f0-9]{64}$/u),
  operationId: uuid(),
  channelId: discordSnowflakeSchema.optional(),
  userId: union([literal("me"), discordSnowflakeSchema]).optional(),
  guildId: discordSnowflakeSchema.optional(),
  comment: string().max(2000).optional(),
}).refine((body) => {
  return (body.channelId === undefined) !== (body.userId === undefined);
}, "Provide exactly one of channelId or userId");

const discordUploadInitResponseSchema = object({
  assetId: uuid(),
  operationId: uuid(),
  url: artifactUrlSchema,
  // A repeated operation whose bytes already exist does not upload again.
  uploadUrl: url().optional(),
  uploadHeaders: record(string(), string()).optional(),
});

const discordUploadOperationBodySchema = object({
  assetId: uuid(),
  operationId: uuid(),
});

const discordUploadResponseSchema = object({
  assetId: uuid(),
  operationId: uuid(),
  url: artifactUrlSchema,
  delivery: discriminatedUnion("status", [
    object({ status: literal("pending") }),
    object({
      status: literal("delivered"),
      channelId: discordSnowflakeSchema,
      messageId: discordSnowflakeSchema,
      attachmentId: discordSnowflakeSchema,
      permalink: url(),
    }),
    object({
      status: literal("failed"),
      message: string(),
      retryable: boolean(),
    }),
  ]),
});

const discordDownloadFileQuerySchema = object({
  guildId: discordSnowflakeSchema.optional(),
  channelId: discordSnowflakeSchema,
  messageId: discordSnowflakeSchema,
  attachmentId: discordSnowflakeSchema,
});

export type DiscordUploadInitBody = zInfer<typeof discordUploadInitBodySchema>;
export type DiscordUploadInitResponse = zInfer<
  typeof discordUploadInitResponseSchema
>;
export type DiscordUploadMaterializeBody = zInfer<
  typeof discordUploadOperationBodySchema
>;
export type DiscordUploadMaterializeResponse = zInfer<
  typeof discordUploadResponseSchema
>;
export type DiscordUploadCompleteBody = DiscordUploadMaterializeBody;
export type DiscordUploadCompleteResponse = DiscordUploadMaterializeResponse;
export type DiscordDownloadFileQuery = zInfer<
  typeof discordDownloadFileQuerySchema
>;

const c = initContract();
const uploadErrors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  413: apiErrorSchema,
  429: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
};

export const integrationsDiscordUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/discord/upload-file/init",
    headers: authHeadersSchema,
    body: discordUploadInitBodySchema,
    responses: { 200: discordUploadInitResponseSchema, ...uploadErrors },
    summary: "Initialize canonical publication for a Discord file",
  },
});

export const integrationsDiscordUploadMaterializeContract = c.router({
  materialize: {
    method: "POST",
    path: "/api/integrations/discord/upload-file/materialize",
    headers: authHeadersSchema,
    body: discordUploadOperationBodySchema,
    responses: { 200: discordUploadResponseSchema, ...uploadErrors },
    summary: "Publish a canonical file before Discord delivery",
  },
});

export const integrationsDiscordUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/discord/upload-file/complete",
    headers: authHeadersSchema,
    body: discordUploadOperationBodySchema,
    responses: { 200: discordUploadResponseSchema, ...uploadErrors },
    summary: "Deliver a canonical file to its authorized Discord destination",
  },
});

export const integrationsDiscordDownloadFileContract = c.router({
  fileUrl: {
    method: "GET",
    path: "/api/integrations/discord/download-file/url",
    headers: authHeadersSchema,
    query: discordDownloadFileQuerySchema,
    responses: { 200: fileDownloadUrlSchema, ...uploadErrors },
    summary: "Resolve a fresh authorized Discord attachment download URL",
  },
});
