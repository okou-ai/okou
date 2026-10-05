import type {
OnboardingIndustry,
OnboardingSubscriptionProvider,
} from "@okouai/api-contracts/contracts/onboarding";
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and,eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";

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
      // No row lock: the INSERT ... ON CONFLICT DO NOTHING result tells this
      // writer whether it created the organization's metadata row, which is
      // the only case that bootstraps the default entitlement. An existing row
      // is completed by a conditional UPDATE; zero rows means onboarding was
      // already complete (or the row was deleted concurrently).
      const [created] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({
          orgId: args.orgId,
          onboardingComplete: true,
          ...industry,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: orgMetadataCanonicalWrites.orgId })
        .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
      const [written] = created
        ? [created]
        : await tx
            .update(orgMetadataCanonicalWrites)
            .set({ onboardingComplete: true, ...industry, updatedAt: now })
            .where(
              and(
                eq(orgMetadataCanonicalWrites.orgId, args.orgId),
                eq(orgMetadataCanonicalWrites.onboardingComplete, false),
              ),
            )
            .returning({ orgId: orgMetadata.orgId, tier: orgMetadata.tier });
      if (!written) {
        return false;
      }
      const entitlement = created ? onboardingEntitlementValues(created) : null;
      if (entitlement) {
        await tx
          .insert(orgPlanEntitlements)
          .values(entitlement)
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      signal.throwIfAborted();
      return true;
    });
  },
);
