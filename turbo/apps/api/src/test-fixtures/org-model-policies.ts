import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { and, eq, sql } from "drizzle-orm";

import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";

import { db } from "../lib/db";
/**
 * The API version before the global addition gate could persist any active
 * model. Stage that historical state to prove a later catalog disablement does
 * not alter or freeze the organization's existing policy.
 */
export async function stagePreAddabilityModelPolicyFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly model: string;
}): Promise<void> {
  const inserted = await db()
    .insert(orgModelPolicies)
    .values({
      orgId: args.orgId,
      model: args.model,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: null,
      createdByUserId: args.userId,
      updatedByUserId: args.userId,
    })
    .returning({ id: orgModelPolicies.id });
  if (inserted.length !== 1) {
    throw new Error("Expected one pre-addability model policy to be inserted");
  }
}

/**
 * Simulate a persisted discriminator written by a later release. The current
 * production API intentionally cannot construct this canonical row because
 * its write fence still rejects `built-in`; compatibility reads still require
 * permanent coverage before that later writer exists.
 */
export async function setOrgModelPolicyProviderTypeFixture(args: {
  readonly orgId: string;
  readonly model: string;
  readonly defaultProviderType: ModelProviderType;
}): Promise<void> {
  const updated = await db()
    .update(orgModelPolicies)
    .set({ defaultProviderType: args.defaultProviderType })
    .where(
      and(
        eq(orgModelPolicies.orgId, args.orgId),
        eq(orgModelPolicies.model, args.model),
      ),
    )
    .returning({ id: orgModelPolicies.id });
  if (updated.length !== 1) {
    throw new Error("Expected one org model policy provider to update");
  }
}

/** The public GET cannot observe these states without repairing them first. */
export async function setOrgMemberRunModelOutsidePolicyFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly selectedModel: string;
}): Promise<void> {
  await db()
    .insert(orgMembersMetadata)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      selectedModel: args.selectedModel,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: { selectedModel: args.selectedModel, updatedAt: sql`now()` },
    });
}
