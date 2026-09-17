import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Two levels only. A template compiled from a file the organization already
 * has is never published beyond it.
 */
const userTemplateVisibilitySchema = z.enum(["private", "organization"]);

/**
 * What the template produces. One value today: the reverse run's conclusion is
 * carried so a client can place the template without parsing a filename.
 */
const userTemplateKindSchema = z.enum(["presentation"]);

const userTemplatePreviewAssetIdSchema = z.string().min(1).max(128);
const userTemplatePreviewAssetSchema = z.object({
  previewAssetId: userTemplatePreviewAssetIdSchema,
  url: z.url(),
  expiresAt: z.iso.datetime(),
});

export const MAX_USER_TEMPLATE_PAGES = 100;
export const MAX_USER_TEMPLATE_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_USER_TEMPLATE_PAGE_BYTES = 25 * 1024 * 1024;
export const MAX_USER_TEMPLATE_TOTAL_PAGE_BYTES = 500 * 1024 * 1024;
export const MAX_USER_TEMPLATE_PACKAGE_BYTES = 100 * 1024 * 1024;
export const MAX_USER_TEMPLATE_PACKAGE_FILES = 200;
export const MAX_USER_TEMPLATE_PACKAGE_FILE_BYTES = 25 * 1024 * 1024;

/**
 * What a reverse run may compile from. These match the file picker the import
 * flow already offers, so a file a user is allowed to choose cannot be rejected
 * after the analysis has already run. Documents follow the Office output
 * toolchain.
 */
export const USER_TEMPLATE_SOURCE_CONTENT_TYPES = [
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
] as const;
export const USER_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";
export const USER_TEMPLATE_PACKAGE_CONTENT_TYPE = "application/gzip";

/** Guidance a later generation run reads. Assets are optional; these are not. */
export const REQUIRED_USER_TEMPLATE_PACKAGE_FILES = [
  "SKILL.md",
  "design-system.md",
] as const;

const userTemplateSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  sourceFilename: z.string(),
  kind: userTemplateKindSchema,
  coverUrl: z.url().nullable(),
  pageCount: z.number().int().positive(),
  visibility: userTemplateVisibilitySchema,
  /**
   * Who uploaded it. The catalog lists the caller's own rows alongside every
   * member's organization-visible ones, so a row the caller cannot manage still
   * has to say whose it is.
   */
  ownerUserId: z.string(),
  canManage: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const userTemplateCatalogEntrySchema = userTemplateSummarySchema.extend({
  previewAssets: z.array(userTemplatePreviewAssetSchema),
});

const userTemplateDetailSchema = userTemplateSummarySchema.extend({
  pageUrls: z.array(z.url()),
  previewAssets: z.array(userTemplatePreviewAssetSchema),
});

const resolveUserTemplatePreviewUrlsBodySchema = z.object({
  previewAssetIds: z
    .array(userTemplatePreviewAssetIdSchema)
    .min(1)
    .max(MAX_USER_TEMPLATE_PAGES),
});

const resolveUserTemplatePreviewUrlsResponseSchema = z.object({
  assets: z.array(userTemplatePreviewAssetSchema),
});

const userTemplateIdParamsSchema = z.object({
  templateId: z.uuid(),
});

const updateUserTemplateBodySchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    visibility: userTemplateVisibilitySchema.optional(),
  })
  .refine((body) => {
    return body.title !== undefined || body.visibility !== undefined;
  }, "A title or visibility change is required");

/**
 * Everything a finished reverse run hands back, in one call.
 *
 * The ids are ordinary private uploads the run already made, so nothing here is
 * a bespoke transfer protocol. Page order is the array order, which is why the
 * whole set arrives together: a single invocation cannot pair one source with
 * another source's pages.
 *
 * There is no create-then-fill pair. A row exists only once this call validates
 * a package, so an abandoned run leaves nothing behind.
 */
const publishUserTemplateBodySchema = z.object({
  title: z.string().trim().min(1).max(255),
  kind: userTemplateKindSchema,
  sourceFileId: z.uuid(),
  pageFileIds: z.array(z.uuid()).min(1).max(MAX_USER_TEMPLATE_PAGES),
  packageFileId: z.uuid(),
});

export const userTemplatesContract = c.router({
  publish: {
    method: "POST",
    path: "/api/user-templates",
    headers: authHeadersSchema,
    body: publishUserTemplateBodySchema,
    responses: {
      200: userTemplateSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Publish a compiled reverse run as a ready user template",
  },
  list: {
    method: "GET",
    path: "/api/user-templates",
    headers: authHeadersSchema,
    responses: {
      200: z.array(userTemplateCatalogEntrySchema),
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List user templates available to the current workspace member",
  },
  get: {
    method: "GET",
    path: "/api/user-templates/:templateId",
    pathParams: userTemplateIdParamsSchema,
    headers: authHeadersSchema,
    responses: {
      200: userTemplateDetailSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get a user template",
  },
  resolvePreviewUrls: {
    method: "POST",
    path: "/api/user-templates/preview-urls",
    headers: authHeadersSchema,
    body: resolveUserTemplatePreviewUrlsBodySchema,
    responses: {
      200: resolveUserTemplatePreviewUrlsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Resolve accessible user template preview asset URLs",
  },
  update: {
    method: "PATCH",
    path: "/api/user-templates/:templateId",
    pathParams: userTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: updateUserTemplateBodySchema,
    responses: {
      200: userTemplateSummarySchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Rename a user template or change its visibility",
  },
  delete: {
    method: "DELETE",
    path: "/api/user-templates/:templateId",
    pathParams: userTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      204: c.noBody(),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete a user template record",
  },
});

export type UserTemplateSummary = z.infer<typeof userTemplateSummarySchema>;
export type UserTemplateCatalogEntry = z.infer<
  typeof userTemplateCatalogEntrySchema
>;
export type UserTemplateDetail = z.infer<typeof userTemplateDetailSchema>;
export type UserTemplatePreviewAsset = z.infer<
  typeof userTemplatePreviewAssetSchema
>;
export type UserTemplateKind = z.infer<typeof userTemplateKindSchema>;
export type UserTemplateVisibility = z.infer<
  typeof userTemplateVisibilitySchema
>;
export type PublishUserTemplateBody = z.infer<
  typeof publishUserTemplateBodySchema
>;
export type UpdateUserTemplateBody = z.infer<
  typeof updateUserTemplateBodySchema
>;
export type UserTemplatesContract = typeof userTemplatesContract;
