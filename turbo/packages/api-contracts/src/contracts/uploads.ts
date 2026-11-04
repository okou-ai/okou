import { artifactUrlSchema } from "./artifact-references";
import {
  array,
  boolean,
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

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const prepareRequestSchema = object({
  /** Fail before creating bytes when private artifact creation is unavailable. */
  requirePrivateArtifact: boolean().optional(),
  filename: string().min(1).max(255),
  contentType: string().min(1).max(200),
  size: number().int().nonnegative(),
  /** Request multipart upload URLs for large files. */
  multipart: literal(true).optional(),
  /** Artifact output; ordinary attachment and processing inputs omit this. */
  purpose: literal("artifact").optional(),
});

const uploadMetadataSchema = object({
  id: string(),
  filename: string(),
  contentType: string(),
  size: number(),
  /** Stable file reference; private artifacts require owner authentication. */
  url: artifactUrlSchema,
});

const prepareResponseSchema = uploadMetadataSchema.extend({
  /** Presigned PUT URL — browser uploads the file body here directly. */
  uploadUrl: url(),
  /** Headers the client must include with the presigned PUT request. */
  uploadHeaders: record(string(), string()),
});

const multipartUploadPartSchema = object({
  partNumber: number().int().positive(),
  uploadUrl: url(),
});

const multipartPrepareResponseSchema = uploadMetadataSchema.extend({
  multipart: object({
    uploadId: string().min(1),
    partSize: number().int().positive(),
    parts: array(multipartUploadPartSchema).min(1),
  }),
});

const prepareResultSchema = union([
  prepareResponseSchema,
  multipartPrepareResponseSchema,
]);

const multipartUploadIdentitySchema = object({
  id: uuid(),
  filename: string().min(1).max(255),
  uploadId: string().min(1),
});

const multipartCompleteRequestSchema = multipartUploadIdentitySchema.extend({
  partCount: number().int().min(1).max(1000),
});

const multipartResponseSchema = object({
  id: uuid(),
  url: artifactUrlSchema,
});

const multipartAbortResponseSchema = object({
  id: uuid(),
});

const completeRequestSchema = object({
  id: uuid(),
  contentType: string().min(1).max(200).optional(),
});

const completeResponseSchema = object({
  id: string(),
  filename: string(),
  contentType: string(),
  size: number(),
  url: artifactUrlSchema,
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Okou upload contract.
 *
 * `prepare` issues a presigned PUT URL so the browser can send the file body
 * straight to R2, bypassing the Next.js runtime's body-size limits. `complete`
 * confirms the object exists after the PUT and persists run associations when
 * the request is authenticated with an Okou run token.
 */
const creationRoute = {
  method: "POST",
  path: "/api/uploads/prepare",
  headers: authHeadersSchema,
  body: prepareRequestSchema,
  responses: {
    200: prepareResultSchema,
    400: apiErrorSchema,
    401: apiErrorSchema,
    402: apiErrorSchema,
    403: apiErrorSchema,
    500: apiErrorSchema,
  },
  summary: "Prepare a direct-to-R2 upload",
} as const;

export const uploadsContract = c.router({
  prepare: creationRoute,
  preparePrivate: {
    ...creationRoute,
    path: "/api/uploads/prepare/private",
  },
  completeMultipart: {
    method: "POST",
    path: "/api/uploads/multipart/complete",
    headers: authHeadersSchema,
    body: multipartCompleteRequestSchema,
    responses: {
      200: multipartResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete a multipart R2 upload",
  },
  abortMultipart: {
    method: "POST",
    path: "/api/uploads/multipart/abort",
    headers: authHeadersSchema,
    body: multipartUploadIdentitySchema,
    responses: {
      200: multipartAbortResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Abort a multipart R2 upload",
  },
  complete: {
    method: "POST",
    path: "/api/uploads/complete",
    headers: authHeadersSchema,
    body: completeRequestSchema,
    responses: {
      200: completeResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete a direct-to-R2 upload",
  },
});

export type UploadsContract = typeof uploadsContract;

// Inferred types
export type UploadPrepareResponse = zInfer<typeof prepareResultSchema>;
export type UploadCompleteResponse = zInfer<typeof completeResponseSchema>;
