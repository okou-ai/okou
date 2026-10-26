import {
  boolean,
  discriminatedUnion,
  iso,
  literal,
  number,
  object,
  record,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

export const HOSTED_SITE_AUTHORIZATION_PATH = "/hosted-site-authorize";
export const HOSTED_SITE_AUTH_CALLBACK_PATH = "/.okou/auth/callback";
export const HOSTED_SITE_AUTH_START_PATH = "/.okou/auth/start";
export const HOSTED_SITE_ACCESS_PATH = "/hosted-site-access";
export const hostedSiteAccessReasonSchema = zEnum([
  "authenticate",
  "denied",
  "expired",
  "unavailable",
]);
export type HostedSiteAccessReason = zInfer<
  typeof hostedSiteAccessReasonSchema
>;
export const hostedSiteReturnPathSchema = string()
  .max(2048)
  .refine((value) => {
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\")
    ) {
      return false;
    }
    const target = new URL(value, "https://site.invalid");
    return (
      target.origin === "https://site.invalid" &&
      !target.pathname.startsWith("/.okou/")
    );
  });
export const hostedSiteAuthProofSchema = string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const hostedSiteAuthCodeSchema = string().regex(/^[a-f0-9]{64}$/u);
export const hostedSiteSessionTokenSchema = string().regex(
  /^okou_site_[a-f0-9]{64}$/u,
);
export const hostedSiteSessionSchema = object({
  sessionToken: hostedSiteSessionTokenSchema,
  expiresAt: iso.datetime(),
});

/** A resource capability, issued only after authorizing this concrete deployment. */
export const hostedSitePreviewGrantSchema = object({
  version: literal(2),
  publicBrand: literal("okou"),
  siteId: uuid(),
  deploymentId: uuid(),
  prefix: string().regex(
    /^(?:sites\/brands\/okou|private-sites\/okou|shared-artifacts\/okou)\/[a-zA-Z0-9/-]+$/u,
  ),
  expiresAt: iso.datetime(),
  immutableContent: literal(true).optional(),
});

export const hostedSiteVisibilitySchema = zEnum([
  "private",
  "organization",
  "public",
]);

export type HostedSiteVisibility = zInfer<typeof hostedSiteVisibilitySchema>;

export const hostedSiteVisibilityStatusSchema = object({
  siteId: uuid(),
  visibility: hostedSiteVisibilitySchema,
  revision: uuid().nullable(),
});

export const hostedSiteBannerStatusSchema = object({
  siteId: uuid(),
  showBanner: boolean(),
  revision: uuid().nullable(),
});

export const hostedSitePresentationSchema = object({
  showBanner: boolean(),
  title: string(),
  siteUrl: url(),
});

export const hostedSiteAccessDecisionSchema = discriminatedUnion("decision", [
  object({
    allowed: literal(true),
    decision: literal("allow"),
    // Only document delivery requests ask for Site presentation metadata.
    presentation: hostedSitePresentationSchema.optional(),
  }),
  object({ allowed: literal(false), decision: literal("authenticate") }),
  object({ allowed: literal(false), decision: literal("deny") }),
]);

export type HostedSiteAccessDecision = zInfer<
  typeof hostedSiteAccessDecisionSchema
>;

export const hostedSiteDownloadGrantSchema = object({
  version: literal(1),
  siteId: uuid(),
  deploymentId: uuid(),
  viewerId: string().min(1).nullable(),
  revision: uuid().nullable(),
  expiresAt: iso.datetime(),
  prefix: string().min(1),
  files: record(
    string(),
    object({ contentType: string(), size: number().int().nonnegative() }),
  ),
});

export const hostedSiteDownloadAuthorizationSchema = object({
  file: object({
    key: string(),
    contentType: string(),
    size: number().int().nonnegative(),
  }).nullable(),
});
