import { command } from "ccstate";
import { and, asc, eq, inArray } from "drizzle-orm";
import type {
  OnboardingIndustry,
  OnboardingSubscriptionProvider,
} from "@okouai/api-contracts/contracts/onboarding";
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import {
  modelPolicyParentLockSql,
  modelPolicyWriterLockSql,
  onboardingModelPolicyWritePlan,
  policySeedValues,
  policySetOwned,
  type OrgModelPolicyRow,
} from "./model-policy.service";

interface OrgOnboardingCompletion {
  readonly orgId: string;
  readonly userId: string;
  readonly industry?: OnboardingIndustry;
  readonly modelProvider?: OnboardingSubscriptionProvider;
}

function onboardingEntitlementValues(metadata: {
  readonly orgId: string;
  readonly tier: string;
}) {
  const tier = orgTierSchema.safeParse(metadata.tier);
  return tier.success
    ? orgPlanEntitlementValues(
        {
          orgId: metadata.orgId,
          tier: tier.data,
          source: "org_metadata_migration",
        },
        { stripeSubscriptionId: null, sourceMetadata: {} },
      )
    : null;
}

/** Metadata, entitlement bootstrap and untouched policy seeding commit together. */
export const markOrgOnboardingComplete$ = command(
  async ({ set }, args: OrgOnboardingCompletion, signal: AbortSignal) => {
    const db = set(writeDb$);
    const now = nowDate();
    const industry =
      args.industry === undefined ? {} : { onboardingIndustry: args.industry };
    signal.throwIfAborted();
    return await db.transaction(async (tx) => {
      const [existingOrg] = await tx
        .select({ id: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .for("update");
      const [written] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId: args.orgId,
          onboardingComplete: true,
          ...industry,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: { onboardingComplete: true, ...industry, updatedAt: now },
          setWhere: eq(orgMetadataCanonicalWrites.onboardingComplete, false),
        })
        .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
      if (!written) {
        return false;
      }
      const entitlement = existingOrg
        ? null
        : onboardingEntitlementValues(written);
      if (entitlement) {
        await tx
          .insert(orgPlanEntitlements)
          .values(entitlement)
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      if (args.modelProvider === undefined) {
        signal.throwIfAborted();
        return true;
      }
      await tx.execute(modelPolicyWriterLockSql(args.orgId));
      const owner = eq(orgModelPolicies.orgId, args.orgId);
      const before = await tx.select().from(orgModelPolicies).where(owner);
      let initializeSeed = false;
      if (before.length === 0) {
        const inserted = await tx
          .insert(orgModelPolicies)
          .values(policySeedValues(args.orgId, args.userId))
          .onConflictDoNothing()
          .returning({ id: orgModelPolicies.id });
        initializeSeed = inserted.length > 0;
      }
      let existing: OrgModelPolicyRow[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        for (const statement of modelPolicyParentLockSql(args.orgId)) {
          await tx.execute(statement);
        }
        const locked = await tx
          .select()
          .from(orgModelPolicies)
          .where(owner)
          .orderBy(asc(orgModelPolicies.id))
          .for("no key update");
        existing = await tx.select().from(orgModelPolicies).where(owner);
        if (policySetOwned(locked, existing)) {
          break;
        }
        if (attempt === 2) {
          throw new Error(
            "Model policies changed concurrently; retry the operation",
          );
        }
      }
      const plan = onboardingModelPolicyWritePlan({
        ...args,
        provider: args.modelProvider,
        existing,
        initializeSeed,
        now,
      });
      if (plan) {
        await tx
          .insert(orgModelPolicies)
          .values(plan.insertValues)
          .onConflictDoNothing({
            target: [orgModelPolicies.orgId, orgModelPolicies.model],
          });
        const removed = await tx
          .delete(orgModelPolicies)
          .where(plan.removalCondition)
          .returning({ model: orgModelPolicies.model });
        if (removed.length > 0) {
          await tx
            .update(orgMembersMetadata)
            .set({
              selectedModel: plan.defaultModel,
              serviceTier: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(orgMembersMetadata.orgId, args.orgId),
                inArray(
                  orgMembersMetadata.selectedModel,
                  removed.map((row) => {
                    return row.model;
                  }),
                ),
              ),
            );
        }
        await tx
          .update(orgModelPolicies)
          .set({ isDefault: false })
          .where(owner);
        for (const update of plan.updates) {
          await tx
            .update(orgModelPolicies)
            .set(update.values)
            .where(update.condition);
        }
      }
      signal.throwIfAborted();
      return true;
    });
  },
);
