import { artifactUrlSchema } from "./artifact-references";
import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

const ORG_SLUG_HASH_LENGTH = 8;
const RANDOM_SLUG_SUFFIX_LENGTH = 8;
const PUBLIC_SLUG_SEPARATOR_LENGTH = 2;
const MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH = 96;

export const hostedArtifactKindSchema = z.enum([
  "hosted-site",
  "presentation-html",
]);
export type HostedArtifactKind = z.infer<typeof hostedArtifactKindSchema>;

export const hostedSiteSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Site slug must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSiteSlugSuffixSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Site slug suffix must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSitePublicSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Hosted site public slug must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSiteFileSchema = z.object({
  path: z.string().min(1).max(1024).regex(/^\//, "File path must start with /"),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().min(1).max(200),
  immutable: z.boolean().optional(),
});

export const hostedSiteDownloadFileSchema = hostedSiteFileSchema.extend({
  downloadUrl: z.string().url(),
});

export const hostedSitePrepareRequestSchema = z
  .object({
    /** Fail before creating bytes when private artifact creation is unavailable. */
    requirePrivateArtifact: z.boolean().optional(),
    site: hostedSiteSlugSchema,
    slugSuffix: hostedSiteSlugSuffixSchema.optional(),
    artifactKind: hostedArtifactKindSchema.default("hosted-site"),
    spaFallback: z.boolean().default(false),
    files: z.array(hostedSiteFileSchema).min(1).max(5000),
  })
  .superRefine((value, ctx) => {
    const suffixLength = value.slugSuffix?.length ?? RANDOM_SLUG_SUFFIX_LENGTH;
    const publicSlugLength =
      value.site.length +
      ORG_SLUG_HASH_LENGTH +
      suffixLength +
      PUBLIC_SLUG_SEPARATOR_LENGTH;

    if (publicSlugLength > MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: value.slugSuffix ? ["slugSuffix"] : ["site"],
        message:
          "Hosted site public slug must be 96 characters or fewer; shorten site or slug suffix",
      });
    }
  });

export const hostedSiteUploadSchema = z.object({
  path: z.string(),
  uploadUrl: z.string().url(),
});

export const hostedSitePrepareResponseSchema = z.object({
  siteId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  publicSlug: z.string(),
  url: artifactUrlSchema,
  deploymentVersion: z.number().int().positive().optional(),
  artifactUrl: artifactUrlSchema.optional(),
  aliasUrl: z.string().url().optional(),
  uploads: z.array(hostedSiteUploadSchema),
});

export const hostedSiteCompleteResponseSchema = z.object({
  siteId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  publicSlug: z.string(),
  url: artifactUrlSchema,
  deploymentVersion: z.number().int().positive().optional(),
  artifactUrl: artifactUrlSchema.optional(),
  aliasUrl: z.string().url().optional(),
  isActive: z.boolean().optional(),
  activeDeploymentVersion: z.number().int().positive().optional(),
  status: z.literal("ready"),
});

export const hostedSiteFilesResponseSchema = z.object({
  siteId: z.string().uuid(),
  deploymentId: z.string().uuid(),
  publicSlug: hostedSitePublicSlugSchema,
  url: artifactUrlSchema,
  deploymentVersion: z.number().int().positive().optional(),
  artifactUrl: artifactUrlSchema.optional(),
  aliasUrl: z.string().url().optional(),
  fileCount: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  files: z.array(hostedSiteDownloadFileSchema),
});

const hostedSiteDeploymentSummarySchema = z.object({
  deploymentId: z.string().uuid(),
  deploymentVersion: z.number().int().positive().nullable(),
  artifactUrl: artifactUrlSchema.nullable(),
  status: z.enum(["uploading", "ready", "failed", "deleted"]),
  isActive: z.boolean(),
  createdAt: z.string().datetime(),
  readyAt: z.string().datetime().nullable(),
});

export const hostedSiteDeploymentsResponseSchema = z.object({
  siteId: z.string().uuid(),
  site: hostedSiteSlugSchema,
  publicSlug: hostedSitePublicSlugSchema,
  aliasUrl: z.string().url().nullable(),
  activeDeploymentId: z.string().uuid().nullable(),
  activeDeploymentVersion: z.number().int().positive().nullable(),
  deployments: z.array(hostedSiteDeploymentSummarySchema),
});

const creationRoute = {
  method: "POST",
  path: "/api/host/deployments/prepare",
  headers: authHeadersSchema,
  body: hostedSitePrepareRequestSchema,
  responses: {
    200: hostedSitePrepareResponseSchema,
    400: apiErrorSchema,
    401: apiErrorSchema,
    402: apiErrorSchema,
    403: apiErrorSchema,
    409: apiErrorSchema,
    500: apiErrorSchema,
  },
  summary: "Prepare a static hosted-site deployment",
} as const;

export const hostContract = c.router({
  privatePreview: {
    method: "GET",
    path: "/api/host/private-deployments/:deploymentId/preview",
    pathParams: z.object({ deploymentId: z.string().uuid() }),
    headers: authHeadersSchema,
    responses: {
      200: z.object({
        url: z.string().url(),
        expiresAt: z.string().datetime(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Authorize an isolated private HTML preview",
  },
  privateView: {
    method: "GET",
    path: "/api/host/private-deployments/:deploymentId/view",
    pathParams: z.object({ deploymentId: z.string().uuid() }),
    headers: authHeadersSchema,
    responses: {
      302: c.otherResponse({ contentType: "text/plain", body: z.unknown() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Redirect an authorized owner to isolated HTML content",
  },

  prepare: creationRoute,
  preparePrivate: {
    ...creationRoute,
    path: "/api/host/deployments/prepare/private",
  },
  complete: {
    method: "POST",
    path: "/api/host/deployments/:deploymentId/complete",
    pathParams: z.object({
      deploymentId: z.string().uuid(),
    }),
    headers: authHeadersSchema,
    body: z.object({}),
    responses: {
      200: hostedSiteCompleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Complete a static hosted-site deployment",
  },
  files: {
    method: "GET",
    path: "/api/host/sites/:publicSlug/files",
    pathParams: z.object({
      publicSlug: hostedSitePublicSlugSchema,
    }),
    query: z.object({
      // Pinned CLIs and historical sites retain this selector until #35240's
      // data/consumer retirement gates. Current CLI selects publication URLs.
      version: z.coerce.number().int().positive().optional(),
      hostname: z.string().min(1).max(253).optional(),
    }),
    headers: authHeadersSchema,
    responses: {
      200: hostedSiteFilesResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List files for a visible hosted publication",
  },
  deployments: {
    // Historical discovery for pinned clients; remove after the complete
    // artifact mapping and client drain documented in #35240.
    method: "GET",
    path: "/api/host/sites/:site/deployments",
    pathParams: z.object({
      site: hostedSiteSlugSchema,
    }),
    headers: authHeadersSchema,
    responses: {
      200: hostedSiteDeploymentsResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "List deployment versions for an owned hosted site",
  },
});

export type HostContract = typeof hostContract;
export type HostedSitePrepareRequest = z.infer<
  typeof hostedSitePrepareRequestSchema
>;
export type HostedSitePrepareResponse = z.infer<
  typeof hostedSitePrepareResponseSchema
>;
export type HostedSiteCompleteResponse = z.infer<
  typeof hostedSiteCompleteResponseSchema
>;
export type HostedSiteFilesResponse = z.infer<
  typeof hostedSiteFilesResponseSchema
>;
export type HostedSiteDeploymentsResponse = z.infer<
  typeof hostedSiteDeploymentsResponseSchema
>;
