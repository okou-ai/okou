import {
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  url,
  uuid,
  null as zNull,
  unknown as zUnknown,
  type infer as zInfer,
} from "zod";

import { artifactUrlSchema } from "./artifact-references";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const MAX_WECHAT_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const wechatIdSchema = uuid();

export const wechatFilenameSchema = string()
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

const wechatUploadInitBodySchema = object({
  filename: wechatFilenameSchema,
  length: number().int().positive().max(MAX_WECHAT_FILE_SIZE_BYTES),
  contentType: string().min(1).max(255),
  checksumSha256: string().regex(/^[a-f0-9]{64}$/u),
  channelId: wechatIdSchema,
  comment: string().max(2000).optional(),
});

const wechatUploadInitResponseSchema = object({
  assetId: uuid(),
  url: artifactUrlSchema,
  uploadUrl: url(),
  uploadHeaders: record(string(), string()),
});

const wechatUploadCompleteBodySchema = object({
  assetId: uuid(),
  channelId: wechatIdSchema,
  comment: string().max(2000).optional(),
});

const wechatUploadResponseSchema = object({
  assetId: uuid(),
  url: artifactUrlSchema,
  delivery: discriminatedUnion("status", [
    object({
      status: literal("delivered"),
      channelId: wechatIdSchema,
      messageId: wechatIdSchema,
      permalink: zNull(),
    }),
    object({
      status: literal("failed"),
      message: string(),
    }),
  ]),
});

const wechatDownloadFileQuerySchema = object({
  channelId: wechatIdSchema,
  messageId: wechatIdSchema,
  attachmentId: string().regex(/^\d{1,3}$/u),
});

export type WechatUploadInitBody = zInfer<typeof wechatUploadInitBodySchema>;
export type WechatUploadInitResponse = zInfer<
  typeof wechatUploadInitResponseSchema
>;
export type WechatUploadCompleteBody = zInfer<
  typeof wechatUploadCompleteBodySchema
>;
export type WechatUploadCompleteResponse = zInfer<
  typeof wechatUploadResponseSchema
>;
export type WechatDownloadFileQuery = zInfer<
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
    summary: "Initialize publication for a Wechat file",
  },
});

export const integrationsWechatUploadCompleteContract = c.router({
  complete: {
    method: "POST",
    path: "/api/integrations/wechat/upload-file/complete",
    headers: authHeadersSchema,
    body: wechatUploadCompleteBodySchema,
    responses: { 200: wechatUploadResponseSchema, ...uploadErrors },
    summary: "Finalize and fire-and-forget deliver a file to WeChat",
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
        body: zUnknown(),
      }),
      ...uploadErrors,
    },
    summary: "Download a Wechat attachment after owner and connection checks",
  },
});
