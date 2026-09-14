/**
 * In-process test fixture for `org_metadata` tier and credit balance.
 *
 * The tier/credit combinations the generation tests exercise cannot be
 * constructed through product APIs: the Stripe webhook path only produces
 * "pro"/"team" orgs with fixed subscription credit grants, "limited-free-1"
 * is only set by the Clerk org-creation bootstrap (which also provisions a
 * default agent/compose), and the legacy "free" tier — still present in
 * production data and load-bearing for voice-io quota limits — has no
 * creation path at all. Exact credit balances (e.g. 0 or 1000) are equally
 * unreachable because product grants come in fixed subscription amounts.
 * The legacy onboarding-payment-pending state also has no write path after
 * removing the retired onboarding setup endpoint, but billing must continue
 * reading existing rows. This module is the narrow test-boundary exception
 * for those persisted states.
 */
import { orgTierSchema } from "@okouai/api-contracts/contracts/orgs";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";

import { writeDb$ } from "../signals/external/db";
import { upsertOrgPlanEntitlement } from "../signals/services/org-plan-entitlements.service";

export async function upsertOrgMetadataFixture(values: {
  readonly orgId: string;
  readonly tier: string;
  readonly credits: number;
}): Promise<void> {
  const tier = orgTierSchema.parse(values.tier);
  await createStore()
    .set(writeDb$)
    .transaction(async (tx) => {
      await tx
        .insert(orgMetadataCanonicalWrites)
        .values(values)
        .onConflictDoUpdate({
          target: orgMetadataCanonicalWrites.orgId,
          set: {
            tier: values.tier,
            credits: values.credits,
            updatedAt: sql`now()`,
          },
        });
      await upsertOrgPlanEntitlement(tx, {
        orgId: values.orgId,
        tier,
        source: "org_metadata_migration",
      });
    });
}

export async function expireAtomGrantFixture(values: {
  readonly orgId: string;
  readonly expiredAt: Date;
}): Promise<void> {
  const db = createStore().set(writeDb$);
  await db
    .update(orgMetadata)
    .set({
      currentPeriodEnd: values.expiredAt,
      updatedAt: values.expiredAt,
    })
    .where(eq(orgMetadata.orgId, values.orgId));
  await db
    .update(creditExpiresRecord)
    .set({ expiresAt: values.expiredAt })
    .where(eq(creditExpiresRecord.orgId, values.orgId));
}

interface OrgAcquisitionAttributionRow {
  readonly acquisitionSourceType: string | null;
  readonly acquisitionFirstPartySource: string | null;
  readonly acquisitionCampaignId: string | null;
  readonly acquisitionAdGroupId: string | null;
  readonly acquisitionCampaign: string | null;
  readonly acquisitionUtmSource: string | null;
  readonly acquisitionUtmMedium: string | null;
  readonly acquisitionUtmContent: string | null;
  readonly acquisitionUtmTerm: string | null;
  readonly acquisitionGclid: string | null;
  readonly acquisitionRecordedAt: Date | null;
}

export async function readOrgAcquisitionAttributionFixture(
  orgId: string,
): Promise<OrgAcquisitionAttributionRow | undefined> {
  const [row] = await createStore()
    .set(writeDb$)
    .select({
      acquisitionSourceType: orgMetadata.acquisitionSourceType,
      acquisitionFirstPartySource: orgMetadata.acquisitionFirstPartySource,
      acquisitionCampaignId: orgMetadata.acquisitionCampaignId,
      acquisitionAdGroupId: orgMetadata.acquisitionAdGroupId,
      acquisitionCampaign: orgMetadata.acquisitionCampaign,
      acquisitionUtmSource: orgMetadata.acquisitionUtmSource,
      acquisitionUtmMedium: orgMetadata.acquisitionUtmMedium,
      acquisitionUtmContent: orgMetadata.acquisitionUtmContent,
      acquisitionUtmTerm: orgMetadata.acquisitionUtmTerm,
      acquisitionGclid: orgMetadata.acquisitionGclid,
      acquisitionRecordedAt: orgMetadata.acquisitionRecordedAt,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row;
}

/**
 * Repoint the org default Agent.
 *
 * The Clerk org-creation bootstrap is the only writer of
 * `org_metadata.default_agent_id`, so a later default-Agent change — which
 * Morning Brief ownership must survive — has no product path to reproduce.
 */
export async function setOrgDefaultAgentFixture(values: {
  readonly orgId: string;
  readonly agentId: string;
}): Promise<void> {
  const rows = await createStore()
    .set(writeDb$)
    .update(orgMetadata)
    .set({ defaultAgentId: values.agentId, updatedAt: sql`now()` })
    .where(eq(orgMetadata.orgId, values.orgId))
    .returning({ orgId: orgMetadata.orgId });
  if (rows.length !== 1) {
    throw new Error("Expected one org metadata row to repoint");
  }
}

export async function setOnboardingPaymentPendingFixture(values: {
  readonly orgId: string;
  readonly onboardingPaymentPending: boolean;
}): Promise<void> {
  await createStore()
    .set(writeDb$)
    .update(orgMetadata)
    .set({
      onboardingPaymentPending: values.onboardingPaymentPending,
      updatedAt: sql`now()`,
    })
    .where(eq(orgMetadata.orgId, values.orgId));
}
