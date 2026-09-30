import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";

import { expireOrgCreditsInTransaction } from "./org-credit-expiration.service";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";

const LIMITED_FREE_ONBOARDING_CREDITS = 1000;

const ONBOARDING_CREDIT_SOURCE = "onboarding";
const ONBOARDING_CREDIT_IDEMPOTENCY_KEY = "limited-free-onboarding";
const ONBOARDING_CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function onboardingCreditsExpiresAt(grantedAt: Date): Date {
  return new Date(grantedAt.getTime() + ONBOARDING_CREDIT_TTL_MS);
}

/**
 * The grant identity and its balance change commit together before publication.
 * The unique onboarding receipt admits one increment, which is atomic
 * arithmetic; no wallet row lock is taken; a replay is an idempotent ON
 * CONFLICT no-op. Expired remainder is cleared first by one conditional
 * statement in this transaction, so the grant is serially after expiration; a
 * lost clear throws OrgCreditExpirationConflict once (no retry loop).
 */
export const grantOnboardingCredits$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({ orgId })
        .onConflictDoNothing()
        .returning({ orgId: orgMetadata.orgId });
      const [metadata] = await tx
        .select({
          tier: orgMetadata.tier,
          defaultAgentId: orgMetadata.defaultAgentId,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId));
      if (!metadata) {
        throw new Error(
          "Organization disappeared before onboarding credit grant",
        );
      }
      if (inserted) {
        await tx
          .insert(orgPlanEntitlements)
          .values(
            orgPlanEntitlementValues(
              {
                orgId,
                tier: "limited-free-1",
                source: "org_metadata_bootstrap",
              },
              { stripeSubscriptionId: null, sourceMetadata: {} },
            ),
          )
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      if (
        metadata.defaultAgentId ||
        ["pro", "team", "custom"].includes(metadata.tier)
      ) {
        return;
      }
      const [existingGrant] = await tx
        .select({ id: creditExpiresRecord.id })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, orgId),
            eq(creditExpiresRecord.source, ONBOARDING_CREDIT_SOURCE),
            eq(
              creditExpiresRecord.stripeInvoiceId,
              ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
            ),
          ),
        )
        .limit(1);
      if (existingGrant) {
        return;
      }
      const at = nowDate();
      await expireOrgCreditsInTransaction(tx, orgId, at);
      const [grant] = await tx
        .insert(creditExpiresRecord)
        .values({
          orgId,
          source: ONBOARDING_CREDIT_SOURCE,
          stripeInvoiceId: ONBOARDING_CREDIT_IDEMPOTENCY_KEY,
          amount: LIMITED_FREE_ONBOARDING_CREDITS,
          remaining: LIMITED_FREE_ONBOARDING_CREDITS,
          expiresAt: onboardingCreditsExpiresAt(at),
        })
        .onConflictDoNothing()
        .returning({ id: creditExpiresRecord.id });
      if (grant) {
        await tx
          .update(orgMetadata)
          .set({
            credits: sql`${orgMetadata.credits} + ${LIMITED_FREE_ONBOARDING_CREDITS}`,
            updatedAt: at,
          })
          .where(eq(orgMetadata.orgId, orgId));
      }
    });
    signal.throwIfAborted();
  },
);
