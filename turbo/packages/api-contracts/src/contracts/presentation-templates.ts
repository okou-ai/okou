import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const presentationTemplateVisibilitySchema = z.enum(["private", "public"]);
const presentationTemplatePreviewAssetIdSchema = z.string().min(1).max(128);
const presentationTemplatePreviewAssetSchema = z.object({
  previewAssetId: presentationTemplatePreviewAssetIdSchema,
  url: z.string().url(),
  expiresAt: z.iso.datetime(),
});

export const MAX_PRESENTATION_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PAGES = 100;
export const MAX_PRESENTATION_TEMPLATE_PAGE_BYTES = 25 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_TOTAL_PAGE_BYTES = 500 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_BYTES = 100 * 1024 * 1024;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILES = 200;
export const MAX_PRESENTATION_TEMPLATE_PACKAGE_FILE_BYTES = 25 * 1024 * 1024;

/** An original deck the user uploaded alongside its rendered page images. */
export const PRESENTATION_TEMPLATE_SOURCE_CONTENT_TYPES = [
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
] as const;
export const PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";
export const PRESENTATION_TEMPLATE_PACKAGE_CONTENT_TYPE = "application/gzip";

/** Guidance a later generation run reads. Assets are optional; these are not. */
export const REQUIRED_PRESENTATION_TEMPLATE_PACKAGE_FILES = [
  "SKILL.md",
  "design-system.md",
] as const;

const presentationTemplateSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  sourceFilename: z.string(),
  coverUrl: z.string().url().nullable(),
  pageCount: z.number().int().nonnegative(),
  visibility: presentationTemplateVisibilitySchema,
  canManage: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const presentationTemplateCatalogEntrySchema =
  presentationTemplateSummarySchema.extend({
    previewAssets: z.array(presentationTemplatePreviewAssetSchema),
  });

const presentationTemplateDetailSchema =
  presentationTemplateSummarySchema.extend({
    pageUrls: z.array(z.string().url()),
    previewAssets: z.array(presentationTemplatePreviewAssetSchema),
  });

const resolvePresentationTemplatePreviewUrlsBodySchema = z.object({
  previewAssetIds: z
    .array(presentationTemplatePreviewAssetIdSchema)
    .min(1)
    .max(MAX_PRESENTATION_TEMPLATE_PAGES),
});

const resolvePresentationTemplatePreviewUrlsResponseSchema = z.object({
  assets: z.array(presentationTemplatePreviewAssetSchema),
});

const presentationTemplateIdParamsSchema = z.object({
  templateId: z.uuid(),
});

const updatePresentationTemplateBodySchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    visibility: presentationTemplateVisibilitySchema.optional(),
  })
  .refine((body) => {
    return body.title !== undefined || body.visibility !== undefined;
  }, "A title or visibility change is required");

/**
 * Everything a finished analysis hands back, in one call.
 *
 * The ids are ordinary private uploads the run already made, so nothing here is
 * a bespoke transfer protocol. Page order is the array order, which is why the
 * whole set arrives together: a single invocation cannot pair one deck's source
 * with another deck's pages.
 */
const publishPresentationTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
  sourceFileId: z.uuid(),
  pageFileIds: z.array(z.uuid()).min(1).max(MAX_PRESENTATION_TEMPLATE_PAGES),
  packageFileId: z.uuid(),
});

export const presentationTemplatesContract = c.router({
  publish: {
    method: "POST",
    path: "/api/presentation-templates",
    headers: authHeadersSchema,
    body: publishPresentationTemplateBodySchema,
    responses: {
      200: presentationTemplateSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Publish an analysed deck as a ready presentation template",
  },
  list: {
    method: "GET",
    path: "/api/presentation-templates",
    headers: authHeadersSchema,
    responses: {
      200: z.array(presentationTemplateCatalogEntrySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "List presentation templates available to the current workspace member",
  },
  get: {
    method: "GET",
    path: "/api/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: presentationTemplateDetailSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get a presentation template",
  },
  resolvePreviewUrls: {
    method: "POST",
    path: "/api/presentation-templates/preview-urls",
    headers: authHeadersSchema,
    body: resolvePresentationTemplatePreviewUrlsBodySchema,
    responses: {
      200: resolvePresentationTemplatePreviewUrlsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve accessible presentation template preview asset URLs",
  },
  update: {
    method: "PATCH",
    path: "/api/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: updatePresentationTemplateBodySchema,
    responses: {
      200: presentationTemplateSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update a presentation template",
  },
  delete: {
    method: "DELETE",
    path: "/api/presentation-templates/:templateId",
    pathParams: presentationTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a presentation template record",
  },
});

export type PresentationTemplatesContract =
  typeof presentationTemplatesContract;
export type PresentationTemplateSummary = z.infer<
  typeof presentationTemplateSummarySchema
>;
export type PresentationTemplateCatalogEntry = z.infer<
  typeof presentationTemplateCatalogEntrySchema
>;
export type PresentationTemplateDetail = z.infer<
  typeof presentationTemplateDetailSchema
>;
export type PresentationTemplatePreviewAsset = z.infer<
  typeof presentationTemplatePreviewAssetSchema
>;
export type PresentationTemplatePreviewAssetId = z.infer<
  typeof presentationTemplatePreviewAssetIdSchema
>;
export type PresentationTemplateVisibility = z.infer<
  typeof presentationTemplateVisibilitySchema
>;
export type UpdatePresentationTemplateBody = z.infer<
  typeof updatePresentationTemplateBodySchema
>;
export type PublishPresentationTemplateBody = z.infer<
  typeof publishPresentationTemplateBodySchema
>;
