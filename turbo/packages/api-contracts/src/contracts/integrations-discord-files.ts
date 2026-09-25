import { z } from "zod";
import { artifactUrlSchema } from "./artifact-references";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const MAX_DISCORD_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const discordIdSchema = z
  .string()
  .regex(/^[1-9]\d{0,19}$/u, "Expected a Discord snowflake ID");

export const discordFilenameSchema = z
  .string()
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

const discordUploadInitBodySchema = z.object({
  filename: discordFilenameSchema,
  length: z.number().int().positive().max(MAX_DISCORD_FILE_SIZE_BYTES),
  contentType: z.string().min(1).max(255),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operationId: z.uuid(),
  channelId: discordIdSchema,
  guildId: discordIdSchema.optional(),
  comment: z.string().max(2000).optional(),
});

const discordUploadInitResponseSchema = z.object({
  assetId: z.uuid(),
  operationId: z.uuid(),
  url: artifactUrlSchema,
  // A repeated operation whose bytes already exist does not upload again.
  uploadUrl: z.url().optional(),
  uploadHeaders: z.record(z.string(), z.string()).optional(),
});

const discordUploadOperationBodySchema = z.object({
  assetId: z.uuid(),
  operationId: z.uuid(),
});

const discordUploadResponseSchema = z.object({
  assetId: z.uuid(),
  operationId: z.uuid(),
  url: artifactUrlSchema,
  delivery: z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({
      status: z.literal("delivered"),
      channelId: discordIdSchema,
      messageId: discordIdSchema,
      attachmentId: discordIdSchema,
      permalink: z.url(),
    }),
    z.object({
      status: z.literal("failed"),
      message: z.string(),
      retryable: z.boolean(),
      retryAfterSeconds: z.number().int().nonnegative().optional(),
    }),
  ]),
});

const discordDownloadFileQuerySchema = z.object({
  guildId: discordIdSchema.optional(),
  channelId: discordIdSchema,
  messageId: discordIdSchema,
  attachmentId: discordIdSchema,
});

export type DiscordUploadInitBody = z.infer<typeof discordUploadInitBodySchema>;
export type DiscordUploadInitResponse = z.infer<
  typeof discordUploadInitResponseSchema
>;
export type DiscordUploadMaterializeBody = z.infer<
  typeof discordUploadOperationBodySchema
>;
export type DiscordUploadMaterializeResponse = z.infer<
  typeof discordUploadResponseSchema
>;
export type DiscordUploadCompleteBody = DiscordUploadMaterializeBody;
export type DiscordUploadCompleteResponse = DiscordUploadMaterializeResponse;
export type DiscordDownloadFileQuery = z.infer<
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
  download: {
    method: "GET",
    path: "/api/integrations/discord/download-file",
    headers: authHeadersSchema,
    query: discordDownloadFileQuerySchema,
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      ...uploadErrors,
    },
    summary: "Download a Discord attachment after user and bot access checks",
  },
});
