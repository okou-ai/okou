import { z } from "zod";
import { orgRoleSchema } from "./org-members";

/**
 * Org tier values
 */
export const orgTierSchema = z.enum([
  "free",
  "limited-free-1",
  "pro",
  "team",
  "custom",
]);
export type OrgTier = z.infer<typeof orgTierSchema>;

const ORG_TIER_SET: ReadonlySet<string> = new Set(orgTierSchema.options);

export function isOrgTier(value: string | null | undefined): value is OrgTier {
  return typeof value === "string" && ORG_TIER_SET.has(value);
}

/**
 * Org response schema
 */
export const orgResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.string().optional(),
  role: orgRoleSchema.optional(),
  createdBy: z.string().optional(),
});

export type OrgResponse = z.infer<typeof orgResponseSchema>;

/**
 * Update org request schema
 *
 * `name` is required: the endpoint only updates the org profile name, so an
 * optional field would let a body carrying only removed keys (`slug`,
 * `force`) parse into an empty no-op update.
 */
export const updateOrgRequestSchema = z.object({
  name: z.string().min(1).max(128),
});

export type UpdateOrgRequest = z.infer<typeof updateOrgRequestSchema>;
