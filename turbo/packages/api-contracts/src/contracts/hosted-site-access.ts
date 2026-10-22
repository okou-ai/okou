import { z } from "zod";

export const HOSTED_SITE_AUTHORIZATION_PATH = "/hosted-site-authorize";
export const HOSTED_SITE_AUTH_CALLBACK_PATH = "/.okou/auth/callback";
export const hostedSiteAuthProofSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u);
export const hostedSiteAuthCodeSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const hostedSiteSessionTokenSchema = z
  .string()
  .regex(/^okou_site_[a-f0-9]{64}$/u);
export const hostedSiteSessionSchema = z.object({
  sessionToken: hostedSiteSessionTokenSchema,
  expiresAt: z.iso.datetime(),
});

export const hostedSiteVisibilitySchema = z.enum([
  "private",
  "organization",
  "public",
]);

export type HostedSiteVisibility = z.infer<typeof hostedSiteVisibilitySchema>;

export const hostedSiteVisibilityStatusSchema = z.object({
  siteId: z.uuid(),
  visibility: hostedSiteVisibilitySchema,
  revision: z.uuid().nullable(),
});

export const hostedSiteAccessDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ allowed: z.literal(true), decision: z.literal("allow") }),
  z.object({ allowed: z.literal(false), decision: z.literal("authenticate") }),
  z.object({ allowed: z.literal(false), decision: z.literal("deny") }),
]);

export type HostedSiteAccessDecision = z.infer<
  typeof hostedSiteAccessDecisionSchema
>;

export const hostedSiteDownloadGrantSchema = z.object({
  version: z.literal(1),
  siteId: z.uuid(),
  deploymentId: z.uuid(),
  viewerId: z.string().min(1).nullable(),
  revision: z.uuid().nullable(),
  expiresAt: z.iso.datetime(),
  prefix: z.string().min(1),
  files: z.record(
    z.string(),
    z.object({ contentType: z.string(), size: z.number().int().nonnegative() }),
  ),
});

export const hostedSiteDownloadAuthorizationSchema = z.object({
  file: z
    .object({
      key: z.string(),
      contentType: z.string(),
      size: z.number().int().nonnegative(),
    })
    .nullable(),
});
