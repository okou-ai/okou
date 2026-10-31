import { artifactUrlSchema } from "./artifact-references";
import {
  array,
  boolean,
  coerce,
  iso,
  literal,
  number,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  ZodIssueCode,
  type infer as zInfer,
} from "zod";

import {
  hostedSiteUrlSlugSchema,
  isHostedSiteDocument,
} from "../validators/host";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

import {
  hostedSiteAccessDecisionSchema,
  hostedSiteVisibilitySchema,
  hostedSiteVisibilityStatusSchema,
  hostedSiteDownloadAuthorizationSchema,
  hostedSiteAuthProofSchema,
  hostedSiteAuthCodeSchema,
  hostedSiteSessionSchema,
  hostedSiteBannerStatusSchema,
} from "./hosted-site-access";

const c = initContract();

export { hostedSiteUrlSlugSchema, isHostedSiteDocument };

export const hostedSiteTitleSchema = string().trim().min(1).max(200);

export const hostedSiteTitleResponseSchema = object({
  siteId: uuid(),
  publicSlug: string(),
  title: hostedSiteTitleSchema,
});

export const hostedSiteUrlSchema = object({
  siteId: string().uuid(),
  publicSlug: string(),
  url: string().url(),
  isActive: boolean(),
});

export const hostedSiteDeliveryPointerSchema = object({
  version: literal(1),
  publicBrand: zEnum(["vm0", "okou"]).optional(),
  publicSlug: string(),
  siteId: string().uuid(),
  deploymentId: string().uuid(),
  deploymentVersion: number().int().positive().optional(),
  artifactUrl: string().optional(),
  prefix: string().startsWith("sites/"),
  manifestKey: string().startsWith("sites/"),
  spaFallback: boolean(),
  updatedAt: string(),
});

const ORG_SLUG_HASH_LENGTH = 8;
const RANDOM_SLUG_SUFFIX_LENGTH = 8;
const PUBLIC_SLUG_SEPARATOR_LENGTH = 2;
const MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH = 96;

export const hostedArtifactKindSchema = zEnum([
  "hosted-site",
  "presentation-html",
]);
export type HostedArtifactKind = zInfer<typeof hostedArtifactKindSchema>;

export const hostedSiteSlugSchema = string()
  .trim()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Site slug must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSiteSlugSuffixSchema = string()
  .trim()
  .min(3)
  .max(32)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Site slug suffix must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSitePublicSlugSchema = string()
  .trim()
  .min(3)
  .max(MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "Hosted site public slug must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
  );

export const hostedSiteFileSchema = object({
  path: string().min(1).max(1024).regex(/^\//, "File path must start with /"),
  size: number().int().nonnegative(),
  sha256: string().regex(/^[a-f0-9]{64}$/),
  contentType: string().min(1).max(200),
  immutable: boolean().optional(),
});

/**
 * Agents and browsers address these by a fixed name, so they cannot carry a
 * content hash. They keep the ordinary revalidating cache policy rather than
 * the immutable one, which bounds how long a changed copy can look stale.
 */
const HOSTED_SITE_FIXED_PATHS: ReadonlySet<string> = new Set([
  "/robots.txt",
  "/humans.txt",
  "/ads.txt",
  "/sitemap.xml",
  "/sitemap-index.xml",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/browserconfig.xml",
  "/site.webmanifest",
  "/manifest.webmanifest",
  "/_headers",
  "/_redirects",
]);

function hasFixedHostedSitePath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    HOSTED_SITE_FIXED_PATHS.has(normalized) ||
    normalized.startsWith("/.well-known/")
  );
}

/** `app-4f3a9c12.js` and `app.4f3a9c12.css` both name their own content. */
function hasContentHashedName(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(name);
}

/**
 * A mutable path may differ between publications of one site: documents because
 * a redeploy replaces them, fixed paths because their name cannot change.
 */
export function isMutableHostedSitePath(file: {
  readonly path: string;
  readonly contentType: string;
}): boolean {
  return isHostedSiteDocument(file) || hasFixedHostedSitePath(file.path);
}

/**
 * Every cacheable asset must name its own content, so one published path always
 * means one byte string across every publication of a site.
 */
export function hostedSiteAssetNameError(file: {
  readonly path: string;
  readonly contentType: string;
}): string | null {
  if (isMutableHostedSitePath(file) || hasContentHashedName(file.path)) {
    return null;
  }
  return `Hosted-site asset must carry a content hash in its file name: ${file.path}. Rename non-HTML files as <name>-<contenthash>.<ext>, for example /assets/app-4f3a9c12.js, and update every HTML/CSS reference to the new name.`;
}

/** A path that already exists in this site must keep serving the same bytes. */
export function hostedSiteAssetContentError(path: string): string {
  return `Hosted-site asset changed without a new file name: ${path}. A published path keeps its original bytes forever. Rename the changed file with its new content hash, update every reference to it, and publish again.`;
}

export const hostedSiteDownloadFileSchema = hostedSiteFileSchema.extend({
  downloadUrl: string().url(),
});

export const MAX_HOSTED_PREVIEW_BYTES = 5 * 1024 * 1024;

export const hostedSitePreviewSchema = object({
  size: number().int().positive().max(MAX_HOSTED_PREVIEW_BYTES),
  sha256: string().regex(/^[a-f0-9]{64}$/),
  contentType: zEnum(["image/png", "image/jpeg"]),
});
export type HostedSitePreview = zInfer<typeof hostedSitePreviewSchema>;

export const hostedSitePrepareRequestSchema = object({
  /** Fail before creating bytes when private artifact creation is unavailable. */
  requirePrivateArtifact: boolean().optional(),
  visibility: hostedSiteVisibilitySchema.optional(),
  site: hostedSiteSlugSchema,
  /** Initial display name; optional for retained CLI clients. */
  title: hostedSiteTitleSchema.optional(),
  slugSuffix: hostedSiteSlugSuffixSchema.optional(),
  artifactKind: hostedArtifactKindSchema.default("hosted-site"),
  spaFallback: boolean().default(false),
  files: array(hostedSiteFileSchema).min(1).max(5000),
  /** Uploaded separately to private storage, never into the public bundle. */
  preview: hostedSitePreviewSchema.optional(),
}).superRefine((value, ctx) => {
  const suffixLength = value.slugSuffix?.length ?? RANDOM_SLUG_SUFFIX_LENGTH;
  const publicSlugLength =
    value.site.length +
    ORG_SLUG_HASH_LENGTH +
    suffixLength +
    PUBLIC_SLUG_SEPARATOR_LENGTH;

  if (publicSlugLength > MAX_HOSTED_SITE_PUBLIC_SLUG_LENGTH) {
    ctx.addIssue({
      code: ZodIssueCode.custom,
      path: value.slugSuffix ? ["slugSuffix"] : ["site"],
      message:
        "Hosted site public slug must be 96 characters or fewer; shorten site or slug suffix",
    });
  }
});

export const hostedSiteUploadSchema = object({
  path: string(),
  uploadUrl: string().url(),
});

export const hostedSitePrepareResponseSchema = object({
  siteId: string().uuid(),
  /** Acknowledges the site policy before uploads or publication can start. */
  visibility: hostedSiteVisibilitySchema.optional(),
  /** Acknowledges explicit titles; absent on APIs predating site titles. */
  title: hostedSiteTitleSchema.optional(),
  deploymentId: string().uuid(),
  publicSlug: string(),
  url: artifactUrlSchema,
  deploymentVersion: number().int().positive().optional(),
  artifactUrl: artifactUrlSchema.optional(),
  aliasUrl: string().url().optional(),
  uploads: array(hostedSiteUploadSchema),
  /** Acknowledges that this API requires the preview before publication. */
  preview: object({ uploadUrl: string().url(), sha256: string() }).optional(),
});

export const hostedSiteCompleteResponseSchema = object({
  siteId: string().uuid(),
  deploymentId: string().uuid(),
  publicSlug: string(),
  url: artifactUrlSchema,
  deploymentVersion: number().int().positive().optional(),
  artifactUrl: artifactUrlSchema.optional(),
  aliasUrl: string().url().optional(),
  isActive: boolean().optional(),
  activeDeploymentVersion: number().int().positive().optional(),
  status: literal("ready"),
  previewImageUrl: artifactUrlSchema.optional(),
});

export const hostedSiteFilesResponseSchema = object({
  siteId: string().uuid(),
  deploymentId: string().uuid(),
  publicSlug: hostedSitePublicSlugSchema,
  url: artifactUrlSchema,
  deploymentVersion: number().int().positive().optional(),
  artifactUrl: artifactUrlSchema.optional(),
  aliasUrl: string().url().optional(),
  fileCount: number().int().nonnegative(),
  size: number().int().nonnegative(),
  files: array(hostedSiteDownloadFileSchema),
});

const hostedSiteDeploymentSummarySchema = object({
  deploymentId: string().uuid(),
  deploymentVersion: number().int().positive().nullable(),
  artifactUrl: artifactUrlSchema.nullable(),
  status: zEnum(["uploading", "ready", "failed", "deleted"]),
  isActive: boolean(),
  createdAt: string().datetime(),
  readyAt: string().datetime().nullable(),
});

export const hostedSiteDeploymentsResponseSchema = object({
  siteId: string().uuid(),
  site: hostedSiteSlugSchema,
  publicSlug: hostedSitePublicSlugSchema,
  aliasUrl: string().url().nullable(),
  activeDeploymentId: string().uuid().nullable(),
  activeDeploymentVersion: number().int().positive().nullable(),
  deployments: array(hostedSiteDeploymentSummarySchema),
});

export const hostedSiteDeleteResponseSchema = object({
  siteId: string().uuid(),
  // The --site value that restores the site when redeployed.
  site: hostedSiteSlugSchema,
  publicSlug: hostedSitePublicSlugSchema,
  aliasUrl: string().url(),
  // Every site and version URL that no longer serves the site.
  offlineUrls: array(string().url()),
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
  resolveAlias: {
    method: "GET",
    path: "/api/host/aliases/:publicSlug",
    pathParams: object({ publicSlug: hostedSitePublicSlugSchema }),
    query: object({ publicBrand: zEnum(["vm0", "okou"]) }),
    responses: {
      200: object({ pointer: hostedSiteDeliveryPointerSchema.nullable() }),
      400: apiErrorSchema,
    },
    summary: "Resolve a published website address",
  },
  siteUrl: {
    method: "GET",
    path: "/api/host/sites/:publicSlug/url",
    pathParams: object({ publicSlug: hostedSitePublicSlugSchema }),
    query: object({ hostname: string().max(253) }),
    headers: authHeadersSchema,
    responses: {
      200: hostedSiteUrlSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read the current address of an owned published website",
  },
  siteUrlAvailability: {
    method: "GET",
    path: "/api/host/sites/:siteId/url-availability",
    pathParams: object({ siteId: string().uuid() }),
    query: object({ publicSlug: hostedSiteUrlSlugSchema }),
    headers: authHeadersSchema,
    responses: {
      200: object({ available: boolean() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Check an owned website's proposed address",
  },
  updateSiteUrl: {
    method: "PATCH",
    path: "/api/host/sites/:siteId/url",
    pathParams: object({ siteId: string().uuid() }),
    body: object({
      publicSlug: hostedSiteUrlSlugSchema,
      expectedPublicSlug: hostedSitePublicSlugSchema,
    }),
    headers: authHeadersSchema,
    responses: {
      200: hostedSiteUrlSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Change an owned published website's address",
  },
  authorizeSiteSession: {
    method: "POST",
    path: "/api/host/sites/:siteId/session-authorizations",
    pathParams: object({ siteId: uuid() }),
    headers: authHeadersSchema,
    body: object({
      origin: url(),
      codeChallenge: hostedSiteAuthProofSchema,
      state: hostedSiteAuthProofSchema,
    }),
    responses: {
      200: object({ callbackUrl: url() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Authorize a site-bound browser session from the trusted App",
  },
  exchangeSiteSession: {
    method: "POST",
    path: "/api/host/sites/:siteId/sessions",
    pathParams: object({ siteId: uuid() }),
    headers: authHeadersSchema,
    body: object({
      origin: url(),
      code: hostedSiteAuthCodeSchema,
      codeVerifier: hostedSiteAuthProofSchema,
    }),
    responses: {
      200: hostedSiteSessionSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Exchange a single-use code using the Worker-held proof",
  },
  sitePreview: {
    method: "GET",
    path: "/api/host/sites/:publicSlug/preview",
    pathParams: object({ publicSlug: hostedSitePublicSlugSchema }),
    query: object({ hostname: string().max(253) }),
    headers: authHeadersSchema,
    responses: {
      200: object({
        url: url(),
        expiresAt: iso.datetime().nullable(),
        previewImageUrl: url().optional(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Resolve a website preview to an anonymous or expiring resource address",
  },
  siteVisibility: {
    method: "GET",
    path: "/api/host/sites/:siteId/visibility",
    pathParams: object({ siteId: uuid() }),
    headers: authHeadersSchema,
    responses: {
      200: hostedSiteVisibilityStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read an owned published site's visibility",
  },
  updateSiteVisibility: {
    method: "PATCH",
    path: "/api/host/sites/:siteId/visibility",
    pathParams: object({ siteId: uuid() }),
    headers: authHeadersSchema,
    body: object({
      visibility: hostedSiteVisibilitySchema,
      expectedRevision: uuid().nullable(),
    }),
    responses: {
      200: hostedSiteVisibilityStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Change an owned published site's visibility",
  },
  siteBanner: {
    method: "GET",
    path: "/api/host/sites/:siteId/branding",
    pathParams: object({ siteId: uuid() }),
    headers: authHeadersSchema,
    responses: {
      200: hostedSiteBannerStatusSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read an owned published site's Okou banner preference",
  },
  updateSiteBanner: {
    method: "PATCH",
    path: "/api/host/sites/:siteId/branding",
    pathParams: object({ siteId: uuid() }),
    headers: authHeadersSchema,
    body: object({
      showBanner: boolean(),
      expectedRevision: uuid().nullable(),
    }),
    responses: {
      200: hostedSiteBannerStatusSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
    },
    summary: "Show or hide the Okou banner on an owned published site",
  },
  siteAccess: {
    method: "GET",
    path: "/api/host/sites/:siteId/access",
    headers: authHeadersSchema,
    pathParams: object({ siteId: uuid() }),
    query: object({ origin: string().url() }),
    responses: {
      200: hostedSiteAccessDecisionSchema,
      400: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Check site access before serving a preview or share",
  },
  downloadAuthorization: {
    method: "GET",
    path: "/api/host/downloads/:token",
    pathParams: object({ token: string().regex(/^[a-f0-9]{48}$/u) }),
    query: object({
      deploymentId: uuid(),
      path: string().startsWith("/").max(1024),
    }),
    responses: {
      200: hostedSiteDownloadAuthorizationSchema,
      400: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Authorize one file under a revocable hosted-site download grant",
  },
  deliveryAuthorization: {
    method: "GET",
    path: "/api/host/delivery/:siteId/:deploymentId",
    headers: authHeadersSchema,
    pathParams: object({
      siteId: string().uuid().toLowerCase(),
      deploymentId: string().uuid().toLowerCase(),
    }),
    query: object({
      alias: hostedSitePublicSlugSchema,
      publicSlug: hostedSitePublicSlugSchema,
      publicBrand: zEnum(["vm0", "okou"]),
      prefix: string().startsWith("sites/").max(1024),
      manifestKey: string().startsWith("sites/").max(1024),
      presentation: literal("banner").optional(),
    }),
    responses: {
      200: hostedSiteAccessDecisionSchema,
      400: apiErrorSchema,
      // Database/invariant failures reach the API's generic error boundary.
      500: object({ error: string() }),
    },
    summary: "Check the current authority of a public hosted deployment",
  },
  prepare: creationRoute,
  preparePrivate: {
    ...creationRoute,
    path: "/api/host/deployments/prepare/private",
  },
  complete: {
    method: "POST",
    path: "/api/host/deployments/:deploymentId/complete",
    pathParams: object({
      deploymentId: string().uuid(),
    }),
    headers: authHeadersSchema,
    body: object({}),
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
    pathParams: object({
      publicSlug: hostedSitePublicSlugSchema,
    }),
    query: object({
      // Pinned CLIs and historical sites retain this selector until #35240's
      // data/consumer retirement gates. Current CLI selects publication URLs.
      version: coerce.number().int().positive().optional(),
      hostname: string().min(1).max(253).optional(),
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
    pathParams: object({
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
  updateSiteTitle: {
    method: "PATCH",
    path: "/api/host/sites/:publicSlug/title",
    pathParams: object({ publicSlug: hostedSitePublicSlugSchema }),
    headers: authHeadersSchema,
    body: object({ title: hostedSiteTitleSchema }),
    responses: {
      200: hostedSiteTitleResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary:
      "Change an owned hosted site's display title without changing its URL",
  },
  deleteSite: {
    method: "DELETE",
    path: "/api/host/sites/:publicSlug",
    pathParams: object({
      publicSlug: hostedSitePublicSlugSchema,
    }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: hostedSiteDeleteResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Take an owned hosted site and all of its versions offline; redeploying restores it",
  },
});

export type HostContract = typeof hostContract;
export type HostedSiteTitleResponse = zInfer<
  typeof hostedSiteTitleResponseSchema
>;
export type HostedSitePrepareRequest = zInfer<
  typeof hostedSitePrepareRequestSchema
>;
export type HostedSitePrepareResponse = zInfer<
  typeof hostedSitePrepareResponseSchema
>;
export type HostedSiteCompleteResponse = zInfer<
  typeof hostedSiteCompleteResponseSchema
>;
export type HostedSiteFilesResponse = zInfer<
  typeof hostedSiteFilesResponseSchema
>;
export type HostedSiteDeploymentsResponse = zInfer<
  typeof hostedSiteDeploymentsResponseSchema
>;
export type HostedSiteDeleteResponse = zInfer<
  typeof hostedSiteDeleteResponseSchema
>;
