import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import { expireOrgCreditsInTransaction } from "./org-credit-expiration.service";

interface OrgCreditGrant {
  readonly orgId: string;
  readonly source: string;
  readonly stripeInvoiceId: string;
  readonly amount: number;
  readonly expiresAt: Date;
  readonly clearAutoRechargePending?: boolean;
}

/**
 * The unique grant identity and its wallet increment commit together, once,
 * with no wallet row lock and no retry: the invoice receipt is admitted by
 * INSERT … ON CONFLICT DO NOTHING (a replay is an idempotent no-op) and the
 * increment is atomic arithmetic. Expired remainder is cleared first by one
 * conditional statement in this transaction, so the grant is serially after
 * expiration; a lost clear throws OrgCreditExpirationConflict and rolls the
 * grant back for its caller (Stripe redelivery / reconcile cycle).
 */
export const grantPurchasedOrgCredits$ = command(
  async (
    { set },
    grant: OrgCreditGrant,
    signal: AbortSignal,
  ): Promise<void> => {
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0215; new non-billing transactions are prohibited.
    await set(writeDb$).transaction(async (tx) => {
      const [inserted] = await tx
        .insert(orgMetadataCanonicalWrites)
        .values({ orgId: grant.orgId })
        .onConflictDoNothing()
        .returning({ orgId: orgMetadata.orgId });
      if (inserted) {
        await tx
          .insert(orgPlanEntitlements)
          .values(
            orgPlanEntitlementValues(
              {
                orgId: grant.orgId,
                tier: "limited-free-1",
                source: "org_metadata_migration",
              },
              { stripeSubscriptionId: null, sourceMetadata: {} },
            ),
          )
          .onConflictDoNothing({ target: orgPlanEntitlements.orgId });
      }
      const [existing] = await tx
        .select({ id: creditExpiresRecord.id })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, grant.orgId),
            eq(creditExpiresRecord.stripeInvoiceId, grant.stripeInvoiceId),
          ),
        )
        .limit(1);
      if (existing) {
        return;
      }
      const at = nowDate();
      await expireOrgCreditsInTransaction(tx, grant.orgId, at);
      const [receipt] = await tx
        .insert(creditExpiresRecord)
        .values({
          orgId: grant.orgId,
          source: grant.source,
          stripeInvoiceId: grant.stripeInvoiceId,
          amount: grant.amount,
          remaining: grant.amount,
          expiresAt: grant.expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: creditExpiresRecord.id });
      if (!receipt) {
        return;
      }
      await tx
        .update(orgMetadata)
        .set({
          credits: sql`${orgMetadata.credits} + ${grant.amount}`,
          ...(grant.clearAutoRechargePending
            ? { autoRechargePendingAt: null }
            : {}),
          updatedAt: at,
        })
        .where(eq(orgMetadata.orgId, grant.orgId));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
