import { z } from "zod";

/** Older public pointers predate the explicit brand and deployment version. */
export const hostedSitePointerSchema = z.object({
  version: z.literal(1),
  publicBrand: z.enum(["vm0", "okou"]).optional(),
  publicSlug: z.string(),
  siteId: z.uuid(),
  deploymentId: z.uuid(),
  deploymentVersion: z.number().int().positive().optional(),
  artifactUrl: z.string().optional(),
  prefix: z.string().startsWith("sites/"),
  manifestKey: z.string().startsWith("sites/"),
  spaFallback: z.boolean(),
  updatedAt: z.string(),
});

export type HostedSitePointer = z.infer<typeof hostedSitePointerSchema>;
