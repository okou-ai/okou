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

export const userTemplatesContract = c.router({
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
export type UpdateUserTemplateBody = z.infer<
  typeof updateUserTemplateBodySchema
>;
export type UserTemplatesContract = typeof userTemplatesContract;
