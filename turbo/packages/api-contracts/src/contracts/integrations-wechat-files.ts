import * as z from "zod";
import { artifactUrlSchema } from "./artifact-references";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const MAX_WECHAT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const wechatIdSchema = z.uuid();

export const wechatFilenameSchema = z
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

const wechatUploadInitBodySchema = z.object({
  filename: wechatFilenameSchema,
  length: z.number().int().positive().max(MAX_WECHAT_FILE_SIZE_BYTES),
  contentType: z.string().min(1).max(255),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operationId: z.uuid(),
  channelId: wechatIdSchema,
  comment: z.string().max(2000).optional(),
});

const wechatUploadInitResponseSchema = z.object({
  assetId: z.uuid(),
  operationId: z.uuid(),
  url: artifactUrlSchema,
  // A repeated operation whose bytes already exist does not upload again.
  uploadUrl: z.url().optional(),
  uploadHeaders: z.record(z.string(), z.string()).optional(),
});

const wechatUploadOperationBodySchema = z.object({
  assetId: z.uuid(),
  operationId: z.uuid(),
});

const wechatUploadResponseSchema = z.object({
  assetId: z.uuid(),
  operationId: z.uuid(),
  url: artifactUrlSchema,
  delivery: z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({
      status: z.literal("delivered"),
      channelId: wechatIdSchema,
      messageId: wechatIdSchema,
      permalink: z.null(),
    }),
    z.object({
      status: z.literal("failed"),
      message: z.string(),
      retryable: z.boolean(),
    }),
  ]),
});

const wechatDownloadFileQuerySchema = z.object({
  channelId: wechatIdSchema,
  messageId: wechatIdSchema,
  attachmentId: z.string().regex(/^\d{1,3}$/u),
});

export type WechatUploadInitBody = z.infer<typeof wechatUploadInitBodySchema>;
export type WechatUploadInitResponse = z.infer<
  typeof wechatUploadInitResponseSchema
>;
export type WechatUploadMaterializeBody = z.infer<
  typeof wechatUploadOperationBodySchema
>;
export type WechatUploadMaterializeResponse = z.infer<
  typeof wechatUploadResponseSchema
>;
export type WechatUploadCompleteBody = WechatUploadMaterializeBody;
export type WechatUploadCompleteResponse = WechatUploadMaterializeResponse;
export type WechatDownloadFileQuery = z.infer<
  typeof wechatDownloadFileQuerySchema
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

export const integrationsWechatUploadInitContract = c.router({
  init: {
    method: "POST",
    path: "/api/integrations/wechat/upload-file/init",
    headers: authHeadersSchema,
    body: wechatUploadInitBodySchema,
    responses: { 200: wechatUploadInitResponseSchema, ...uploadErrors },
    summary: "Initialize canonical publication for a Wechat file",
  },
});

export const integrationsWechatUploadMaterializeContract = c.router({
  materialize: {
    method: "POST",
    path: "/api/integrations/wechat/upload-file/materialize",
    headers: authHeadersSchema,
    body: wechatUploadOperationBodySchema,
    responses: { 200: wechatUploadResponseSchema, ...uploadErrors },
    summary: "Publish a canonical file before Wechat delivery",
  },
});

export const integrationsWechatUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/wechat/upload-file/complete",
    headers: authHeadersSchema,
    body: wechatUploadOperationBodySchema,
    responses: { 200: wechatUploadResponseSchema, ...uploadErrors },
    summary: "Deliver a canonical file to its verified WeChat destination",
  },
});

export const integrationsWechatDownloadFileContract = c.router({
  download: {
    method: "GET",
    path: "/api/integrations/wechat/download-file",
    headers: authHeadersSchema,
    query: wechatDownloadFileQuerySchema,
    responses: {
      200: c.otherResponse({
        contentType: "application/octet-stream",
        body: z.unknown(),
      }),
      ...uploadErrors,
    },
    summary: "Download a Wechat attachment after owner and connection checks",
  },
});
