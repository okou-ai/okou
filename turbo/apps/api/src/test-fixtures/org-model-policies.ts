import type { ModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import { and, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
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

/**
 * Historical/uninitialized storage is not constructible through policy PUT,
 * and policy GET repairs it. Own this persisted gap to prove rejected writes
 * cannot seed policies, add the fixed default, or rewrite member preferences.
 * `missing_default` is a policy list written before the fixed default existed.
 */
export async function stageUnrepairedOrgModelPolicyFixture(args: {
  readonly orgId: string;
  readonly state: "unseeded" | "missing_default";
}): Promise<void> {
  await db()
    .delete(orgModelPolicies)
    .where(
      args.state === "unseeded"
        ? eq(orgModelPolicies.orgId, args.orgId)
        : and(
            eq(orgModelPolicies.orgId, args.orgId),
            eq(orgModelPolicies.model, "okou-1.0"),
          ),
    );
}

/** The public GET cannot observe these states without repairing them first. */
export async function readUnrepairedOrgModelPolicyFixture(orgId: string) {
  const policies = await db()
    .select()
    .from(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, orgId))
    .orderBy(orgModelPolicies.model);
  const preferences = await db()
    .select({
      userId: orgMembersMetadata.userId,
      selectedModel: orgMembersMetadata.selectedModel,
      serviceTier: orgMembersMetadata.serviceTier,
      updatedAt: orgMembersMetadata.updatedAt,
    })
    .from(orgMembersMetadata)
    .where(eq(orgMembersMetadata.orgId, orgId))
    .orderBy(orgMembersMetadata.userId);
  return { policies, preferences };
}

/**
 * Stage a member run preference outside the organization's policy. Policy
 * writes migrate member preferences, and the preference route rejects models
 * outside the policy, so neither can construct this state; it proves that a
 * media-only preference write still succeeds while it persists.
 */
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
