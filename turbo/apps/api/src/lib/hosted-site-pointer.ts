import { z } from "zod";
import { linkLayoutSegmentSchema } from "@okouai/api-contracts/contracts/link-layout";

/**
 * Older public pointers predate the layout marker (`publicBrand`, legacy when
 * absent) and the deployment version.
 */
export const hostedSitePointerSchema = z.object({
  version: z.literal(1),
  publicBrand: linkLayoutSegmentSchema.optional(),
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
