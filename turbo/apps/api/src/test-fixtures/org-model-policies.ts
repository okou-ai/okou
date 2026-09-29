import type {
  ModelProviderType,
  SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
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
  readonly model: SupportedRunModel;
}): Promise<void> {
  const inserted = await db()
    .insert(orgModelPolicies)
    .values({
      orgId: args.orgId,
      model: args.model,
      isDefault: false,
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

/** Only a historical writer could leave one retired default and no active policies. */
export async function stageSoleRetiredDefaultPolicyFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly model: "okou-1.0-pro" | "okou-1.0-max";
}): Promise<void> {
  await db().transaction(async (tx) => {
    await tx
      .delete(orgModelPolicies)
      .where(eq(orgModelPolicies.orgId, args.orgId));
    await tx.insert(orgModelPolicies).values({
      orgId: args.orgId,
      model: args.model,
      isDefault: true,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      modelProviderSurfaceId: null,
      createdByUserId: args.userId,
      updatedByUserId: args.userId,
    });
  });
}

/** Enable one model in the test database without changing the production catalog. */
export async function enableRunModelCatalogEntryFixture(
  model: SupportedRunModel,
): Promise<() => Promise<void>> {
  const [existing] = await db()
    .select({ allowNewOrgPolicy: runModelCatalog.allowNewOrgPolicy })
    .from(runModelCatalog)
    .where(eq(runModelCatalog.model, model))
    .limit(1);
  await db()
    .insert(runModelCatalog)
    .values({ model, allowNewOrgPolicy: true })
    .onConflictDoUpdate({
      target: runModelCatalog.model,
      set: { allowNewOrgPolicy: true },
    });
  return async () => {
    if (existing) {
      await db()
        .update(runModelCatalog)
        .set({ allowNewOrgPolicy: existing.allowNewOrgPolicy })
        .where(eq(runModelCatalog.model, model));
    } else {
      await db()
        .delete(runModelCatalog)
        .where(eq(runModelCatalog.model, model));
    }
  };
}

/** Remove one operator catalog row to exercise the production fail-closed path. */
export async function removeRunModelCatalogEntryFixture(
  model: SupportedRunModel,
): Promise<() => Promise<void>> {
  const [removed] = await db()
    .delete(runModelCatalog)
    .where(eq(runModelCatalog.model, model))
    .returning();
  if (!removed) {
    throw new Error(`Expected run model catalog entry for ${model}`);
  }

  let restored = false;
  return async () => {
    if (restored) {
      return;
    }
    await db()
      .insert(runModelCatalog)
      .values(removed)
      .onConflictDoNothing({ target: runModelCatalog.model });
    restored = true;
  };
}

/**
 * Simulate a persisted discriminator written by a later release. The current
 * production API intentionally cannot construct this canonical row because
 * its write fence still rejects `built-in`; compatibility reads still require
 * permanent coverage before that later writer exists.
 */
export async function setOrgModelPolicyProviderTypeFixture(args: {
  readonly orgId: string;
  readonly model: SupportedRunModel;
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
 * Stage a member run preference outside the organization's policy. Policy
 * writes migrate member preferences, and the preference route rejects models
 * outside the policy, so neither can construct this state; it proves that a
 * media-only preference write still succeeds while it persists.
 */
export async function setOrgMemberRunModelOutsidePolicyFixture(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly selectedModel: SupportedRunModel;
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
