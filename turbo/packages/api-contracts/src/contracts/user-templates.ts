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
 * What the template produces, as the reverse run concluded it. Carried rather
 * than derived so a client places the template without parsing a filename, and
 * so a source that could compile either way says which it became.
 */
/**
 * One list, so a new kind reaches the wire schema and every caller that offers
 * a choice from the same edit.
 */
export const USER_TEMPLATE_KINDS = [
  "presentation",
  "document",
  "illustration",
] as const;

const userTemplateKindSchema = z.enum(USER_TEMPLATE_KINDS);

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
 * What a reverse run may compile from, per kind. These match the file picker
 * the import flow already offers, so a file a user is allowed to choose cannot
 * be rejected after the analysis has already run. Documents follow the Office
 * output toolchain.
 *
 * Keyed by kind rather than one flat list because the source is not only the
 * input: an illustration is shown in the catalog by the picture it was
 * reversed from, so its source has to be something a browser can draw. A flat
 * list would accept a `.docx` published as an illustration and leave the grid
 * with a tile that never loads. The two document formats stay where the reader
 * opens them in a viewer instead.
 *
 * The image formats are the intersection of what the reverse scripts read and
 * what a browser renders, minus what makes a poor reference. TIFF, JPEG 2000
 * and Netpbm are readable and are deliberately absent: they would measure fine
 * and then fail to paint. GIF paints and is absent anyway — it animates, and
 * the cover is drawn as one still image, and its palette is quantised to 256
 * colours, so the colour axis would describe the encoder rather than the
 * style. WebP is present for the opposite reason to the first group: the
 * scripts convert it before measuring, and it is what a phone or a web page
 * hands over.
 */
export const USER_TEMPLATE_SOURCE_CONTENT_TYPES: Readonly<
  Record<UserTemplateKind, readonly string[]>
> = {
  presentation: [
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/pdf",
  ],
  document: [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  illustration: ["image/png", "image/jpeg", "image/bmp", "image/webp"],
};
export const USER_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";
export const USER_TEMPLATE_PACKAGE_CONTENT_TYPE = "application/gzip";

/**
 * What a later generation run must find in the package, per kind.
 *
 * `SKILL.md` is common because it is what the run loads. A deck additionally
 * requires `design-system.md`, the written account of its visual language,
 * because its skill is guidance that has nothing to point at without it.
 *
 * A document requires nothing else. Its skill names the artifact it consumes
 * and the command that consumes it, so the package is free to carry whatever
 * that account calls for — `reference.docx` today, something else tomorrow —
 * without this list having to be told. Naming a file here would let a reverse
 * skill that changed its own output be rejected by an endpoint that had not
 * changed with it.
 *
 * An illustration requires nothing else either, and specifically not a
 * `design-system.md`: its skill puts the locked frame, the dials and the
 * prompt in `SKILL.md` itself, and the example pictures it saves beside them
 * are named after the subject and dials they demonstrate, so there is no fixed
 * path to demand. Demanding the deck's second file here is how the document
 * kind first shipped rejecting every package its own skill wrote.
 *
 * Keyed by kind rather than one flat list, so a kind added to
 * `USER_TEMPLATE_KINDS` fails to compile until someone says what its package
 * has to contain. A single shared list is how the document kind shipped
 * demanding a `design-system.md` that its reverse skill never writes, which
 * rejected every document package at publish.
 *
 * The source file is not here either. The reverse skills copy it under its
 * original name, so there is no fixed path to require.
 */
export const REQUIRED_USER_TEMPLATE_PACKAGE_FILES: Readonly<
  Record<UserTemplateKind, readonly string[]>
> = {
  presentation: ["SKILL.md", "design-system.md"],
  document: ["SKILL.md"],
  illustration: ["SKILL.md"],
};

const userTemplateSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  sourceFilename: z.string(),
  kind: userTemplateKindSchema,
  coverUrl: z.url().nullable(),
  /**
   * Null for a kind that has no pages. A document template is its styles and
   * an illustration template is one picture, not a sequence of rendered pages,
   * so counting them would report a zero that reads as "empty" rather than
   * "not applicable". An illustration still has a `coverUrl`: that is its
   * source file, which is not a page.
   */
  pageCount: z.number().int().positive().nullable(),
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
  /**
   * An expiring URL for the file this template was compiled from.
   *
   * Here rather than on the summary because it is what a reader opens, not
   * what a catalog lists: a document template renders no pages, so the source
   * is the only thing there is to show, and signing one per row for a grid
   * nobody has opened yet would pay for URLs that expire unread.
   */
  sourceUrl: z.url(),
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
const publishUserTemplateBaseSchema = z.object({
  title: z.string().trim().min(1).max(255),
  sourceFileId: z.uuid(),
  packageFileId: z.uuid(),
});

/**
 * Page images are a presentation's requirement, not a template's.
 *
 * A deck's cover is its first slide, so the pages are how it is recognised and
 * previewed. A document's identity is its styles, and rendering it to images
 * would add a dependency that buys nothing, so the document arm does not carry
 * them and cannot be sent them by mistake.
 *
 * An illustration carries none either, for the opposite reason: its source is
 * already a picture, so the catalog shows that file rather than a rendering of
 * it. Sending pages would be sending a second copy of the cover.
 */
const publishUserTemplateBodySchema = z.discriminatedUnion("kind", [
  publishUserTemplateBaseSchema.extend({
    kind: z.literal("presentation"),
    pageFileIds: z.array(z.uuid()).min(1).max(MAX_USER_TEMPLATE_PAGES),
  }),
  publishUserTemplateBaseSchema.extend({
    kind: z.literal("document"),
  }),
  publishUserTemplateBaseSchema.extend({
    kind: z.literal("illustration"),
  }),
]);

/**
 * Replace a template's compiled package, leaving everything else alone.
 *
 * Adjusting the package is not re-reversing the source: the file it was
 * compiled from has not changed, so its rendered pages have not either, and
 * the manifest keeps saying what it said. Only the guidance a later run reads
 * is replaced.
 *
 * No kind here. The row already records what this template produces, and the
 * required files follow from it; a body that restated the kind could disagree
 * with the row, and a package swap is not the moment to relitigate what the
 * reverse run concluded. A template that should be a different kind is a
 * different template.
 */
const replaceUserTemplatePackageBodySchema = z.object({
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
  replacePackage: {
    method: "PUT",
    path: "/api/user-templates/:templateId/package",
    pathParams: userTemplateIdParamsSchema,
    headers: authHeadersSchema,
    body: replaceUserTemplatePackageBodySchema,
    responses: {
      200: userTemplateSummarySchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Replace a user template's compiled package",
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
export type ReplaceUserTemplatePackageBody = z.infer<
  typeof replaceUserTemplatePackageBodySchema
>;
export type UserTemplatesContract = typeof userTemplatesContract;
