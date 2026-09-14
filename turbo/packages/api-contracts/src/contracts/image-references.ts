import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { PRESIGNED_URL_TTL_SECONDS } from "./presigned-urls";

const c = initContract();

export const IMAGE_REFERENCE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const MAX_IMAGE_REFERENCE_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_REFERENCE_DIMENSION = 16_384;
export const MAX_IMAGE_REFERENCE_PIXELS = 67_108_864;
export const IMAGE_REFERENCE_PREVIEW_URL_TTL_SECONDS =
  PRESIGNED_URL_TTL_SECONDS;
export const MAX_IMAGE_REFERENCE_PREVIEW_URLS = 100;

const imageReferenceVisibilitySchema = z.enum(["private", "public"]);
const imageReferenceContentTypeSchema = z.enum(IMAGE_REFERENCE_CONTENT_TYPES);
const imageReferencePreviewUrlSchema = z
  .object({
    referenceId: z.uuid(),
    url: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .strict();

const prepareImageReferenceUploadBodySchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: imageReferenceContentTypeSchema,
    size: z.number().int().positive().max(MAX_IMAGE_REFERENCE_SOURCE_BYTES),
  })
  .strict();

const prepareImageReferenceUploadResponseSchema = z
  .object({
    sourceFileId: z.uuid(),
    uploadUrl: z.url(),
    uploadHeaders: z.record(z.string(), z.string()),
  })
  .strict();

const imageReferenceSchema = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(80),
    visibility: imageReferenceVisibilitySchema,
    ownerUserId: z.string().min(1),
    creator: z
      .object({
        userId: z.string().min(1),
        displayName: z.string().min(1).nullable(),
        imageUrl: z.url().nullable(),
      })
      .strict(),
    sourceFilename: z.string().min(1),
    contentType: imageReferenceContentTypeSchema,
    width: z.number().int().positive().max(MAX_IMAGE_REFERENCE_DIMENSION),
    height: z.number().int().positive().max(MAX_IMAGE_REFERENCE_DIMENSION),
    previewUrl: z.url(),
    previewUrlExpiresAt: z.iso.datetime(),
    canManage: z.boolean(),
    canModerate: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const imageReferenceIdParamsSchema = z
  .object({ referenceId: z.uuid() })
  .strict();

const createImageReferenceBodySchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    sourceFileId: z.uuid(),
    visibility: imageReferenceVisibilitySchema.default("private"),
  })
  .strict();

const updateImageReferenceBodySchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    visibility: imageReferenceVisibilitySchema.optional(),
  })
  .strict()
  .refine((body) => {
    return body.title !== undefined || body.visibility !== undefined;
  }, "A title or visibility change is required");

const resolveImageReferencePreviewUrlsBodySchema = z
  .object({
    referenceIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_IMAGE_REFERENCE_PREVIEW_URLS),
  })
  .strict();

const resolveImageReferencePreviewUrlsResponseSchema = z
  .object({ previews: z.array(imageReferencePreviewUrlSchema) })
  .strict();

export const imageReferencesContract = c.router({
  prepareUpload: {
    method: "POST",
    path: "/api/image-references/uploads/prepare",
    headers: authHeadersSchema,
    body: prepareImageReferenceUploadBodySchema,
    responses: {
      200: prepareImageReferenceUploadResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Prepare a private image-reference source upload",
  },
  create: {
    method: "POST",
    path: "/api/image-references",
    headers: authHeadersSchema,
    body: createImageReferenceBodySchema,
    responses: {
      201: imageReferenceSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Create a reusable image reference from a private upload",
  },
  list: {
    method: "GET",
    path: "/api/image-references",
    headers: authHeadersSchema,
    responses: {
      200: z.array(imageReferenceSchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List image references accessible in the active organization",
  },
  resolvePreviewUrls: {
    method: "POST",
    path: "/api/image-references/preview-urls",
    headers: authHeadersSchema,
    body: resolveImageReferencePreviewUrlsBodySchema,
    responses: {
      200: resolveImageReferencePreviewUrlsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve short-lived previews for accessible image references",
  },
  get: {
    method: "GET",
    path: "/api/image-references/:referenceId",
    pathParams: imageReferenceIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: imageReferenceSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get an accessible image reference",
  },
  update: {
    method: "PATCH",
    path: "/api/image-references/:referenceId",
    pathParams: imageReferenceIdParamsSchema,
    headers: authHeadersSchema,
    body: updateImageReferenceBodySchema,
    responses: {
      200: imageReferenceSchema,
      204: c.noBody(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update or moderate an image reference",
  },
  delete: {
    method: "DELETE",
    path: "/api/image-references/:referenceId",
    pathParams: imageReferenceIdParamsSchema,
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete an owned image reference",
  },
});

export type ImageReferencesContract = typeof imageReferencesContract;
export type ImageReference = z.infer<typeof imageReferenceSchema>;
export type ImageReferencePreviewUrl = z.infer<
  typeof imageReferencePreviewUrlSchema
>;
export type ImageReferenceVisibility = z.infer<
  typeof imageReferenceVisibilitySchema
>;
export type ImageReferenceContentType = z.infer<
  typeof imageReferenceContentTypeSchema
>;
export type CreateImageReferenceBody = z.infer<
  typeof createImageReferenceBodySchema
>;
export type UpdateImageReferenceBody = z.infer<
  typeof updateImageReferenceBodySchema
>;
