import {
  array,
  boolean,
  iso,
  number,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const presentationTemplateVisibilitySchema = zEnum(["private", "public"]);
const presentationTemplatePreviewAssetIdSchema = string().min(1).max(128);
const presentationTemplatePreviewAssetSchema = object({
  previewAssetId: presentationTemplatePreviewAssetIdSchema,
  url: url(),
  expiresAt: iso.datetime(),
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

const presentationTemplateSummarySchema = object({
  id: uuid(),
  title: string(),
  sourceFilename: string(),
  coverUrl: url().nullable(),
  pageCount: number().int().nonnegative(),
  visibility: presentationTemplateVisibilitySchema,
  canManage: boolean(),
  createdAt: string(),
  updatedAt: string(),
});

const presentationTemplateCatalogEntrySchema =
  presentationTemplateSummarySchema.extend({
    previewAssets: array(presentationTemplatePreviewAssetSchema),
  });

const presentationTemplateDetailSchema =
  presentationTemplateSummarySchema.extend({
    pageUrls: array(url()),
    previewAssets: array(presentationTemplatePreviewAssetSchema),
  });

const resolvePresentationTemplatePreviewUrlsBodySchema = object({
  previewAssetIds: array(presentationTemplatePreviewAssetIdSchema)
    .min(1)
    .max(MAX_PRESENTATION_TEMPLATE_PAGES),
});

const resolvePresentationTemplatePreviewUrlsResponseSchema = object({
  assets: array(presentationTemplatePreviewAssetSchema),
});

const presentationTemplateIdParamsSchema = object({
  templateId: uuid(),
});

const updatePresentationTemplateBodySchema = object({
  title: string().trim().min(1).max(255).optional(),
  visibility: presentationTemplateVisibilitySchema.optional(),
}).refine((body) => {
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
const publishPresentationTemplateBodySchema = object({
  title: string().trim().min(1).max(255),
  sourceFileId: uuid(),
  pageFileIds: array(uuid()).min(1).max(MAX_PRESENTATION_TEMPLATE_PAGES),
  packageFileId: uuid(),
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
      200: array(presentationTemplateCatalogEntrySchema),
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
export type PresentationTemplateSummary = zInfer<
  typeof presentationTemplateSummarySchema
>;
export type PresentationTemplateCatalogEntry = zInfer<
  typeof presentationTemplateCatalogEntrySchema
>;
export type PresentationTemplateDetail = zInfer<
  typeof presentationTemplateDetailSchema
>;
export type PresentationTemplatePreviewAsset = zInfer<
  typeof presentationTemplatePreviewAssetSchema
>;
export type PresentationTemplatePreviewAssetId = zInfer<
  typeof presentationTemplatePreviewAssetIdSchema
>;
export type PresentationTemplateVisibility = zInfer<
  typeof presentationTemplateVisibilitySchema
>;
export type UpdatePresentationTemplateBody = zInfer<
  typeof updatePresentationTemplateBodySchema
>;
export type PublishPresentationTemplateBody = zInfer<
  typeof publishPresentationTemplateBodySchema
>;
