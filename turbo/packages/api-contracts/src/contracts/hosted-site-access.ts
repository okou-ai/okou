import { z } from "zod";

export const hostedSiteVisibilitySchema = z.enum([
  "private",
  "organization",
  "public",
]);

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
