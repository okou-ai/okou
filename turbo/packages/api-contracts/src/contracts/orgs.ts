import { object, string, enum as zEnum, type infer as zInfer } from "zod";

import { orgRoleSchema } from "./org-members";

/**
 * Org tier values
 */
export const orgTierSchema = zEnum(["limited-free-1", "pro", "team", "custom"]);
export type OrgTier = zInfer<typeof orgTierSchema>;

const ORG_TIER_SET: ReadonlySet<string> = new Set(orgTierSchema.options);

export function isOrgTier(value: string | null | undefined): value is OrgTier {
  return typeof value === "string" && ORG_TIER_SET.has(value);
}

/**
 * Org response schema
 */
export const orgResponseSchema = object({
  id: string(),
  name: string(),
  tier: string().optional(),
  role: orgRoleSchema.optional(),
  createdBy: string().optional(),
});

export type OrgResponse = zInfer<typeof orgResponseSchema>;

/**
 * Update org request schema
 *
 * `name` is required: the endpoint only updates the org profile name, so an
 * optional field would let a body carrying only removed keys (`slug`,
 * `force`) parse into an empty no-op update.
 */
export const updateOrgRequestSchema = object({
  name: string().min(1).max(128),
});

export type UpdateOrgRequest = zInfer<typeof updateOrgRequestSchema>;
