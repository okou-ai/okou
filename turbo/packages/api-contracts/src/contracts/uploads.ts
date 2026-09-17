import { artifactUrlSchema } from "./artifact-references";
import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const prepareRequestSchema = z.object({
  /** Fail before creating bytes when private artifact creation is unavailable. */
  requirePrivateArtifact: z.boolean().optional(),
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(200),
  size: z.number().int().nonnegative(),
  /** Request multipart upload URLs for large files. */
  multipart: z.literal(true).optional(),
  /** Artifact output; ordinary attachment and processing inputs omit this. */
  purpose: z.literal("artifact").optional(),
});

const uploadMetadataSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  /** Stable file reference; private artifacts require owner authentication. */
  url: artifactUrlSchema,
});

const prepareResponseSchema = uploadMetadataSchema.extend({
  /** Presigned PUT URL — browser uploads the file body here directly. */
  uploadUrl: z.string().url(),
  /** Headers the client must include with the presigned PUT request. */
  uploadHeaders: z.record(z.string(), z.string()),
});

const multipartUploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  uploadUrl: z.string().url(),
});

const multipartPrepareResponseSchema = uploadMetadataSchema.extend({
  multipart: z.object({
    uploadId: z.string().min(1),
    partSize: z.number().int().positive(),
    parts: z.array(multipartUploadPartSchema).min(1),
  }),
});

const prepareResultSchema = z.union([
  prepareResponseSchema,
  multipartPrepareResponseSchema,
]);

const multipartUploadIdentitySchema = z.object({
  id: z.string().uuid(),
  filename: z.string().min(1).max(255),
  uploadId: z.string().min(1),
});

const multipartCompleteRequestSchema = multipartUploadIdentitySchema.extend({
  partCount: z.number().int().min(1).max(1000),
});

const multipartResponseSchema = z.object({
  id: z.string().uuid(),
  url: artifactUrlSchema,
});

const multipartAbortResponseSchema = z.object({
  id: z.string().uuid(),
});

const completeRequestSchema = z.object({
  id: z.string().uuid(),
  contentType: z.string().min(1).max(200).optional(),
});

const completeResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
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
export type UploadPrepareResponse = z.infer<typeof prepareResultSchema>;
export type UploadCompleteResponse = z.infer<typeof completeResponseSchema>;
