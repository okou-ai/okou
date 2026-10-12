import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import {
  orgCreditExpirationOutcome,
  orgCreditExpirationOutcomeRow,
  orgCreditExpirationSql,
  pendingOrgCreditExpirationQuery,
  requireCompleteOrgCreditExpiration,
} from "./org-credit-expiration";

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
 * after the existing wallet row lock, with no retry: the invoice is admitted by
 * INSERT … ON CONFLICT DO NOTHING (a replay is an idempotent no-op) and the
 * increment is atomic arithmetic. Expiration clears the cohort and clamps the
 * wallet, then checks a fresh statement snapshot when a lot changed. Remaining
 * expired credit throws OrgCreditExpirationConflict before commit and rolls
 * this operation back for its caller (Stripe redelivery / reconcile cycle).
 */
export const grantPurchasedOrgCredits$ = command(
  async (
    { set },
    grant: OrgCreditGrant,
    signal: AbortSignal,
  ): Promise<void> => {
    // eslint-disable-next-line api/no-db-transaction -- Billing atomicity: expiration clear/clamp, accepted invoice receipt and wallet increment must commit together or fully roll back; single-statement alternative: an initial CTE snapshot cannot preserve the fresh expired-remainder rejection before commit.
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
      // Cash writers acquire the wallet before grant/expiry-lot locks.
      await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, grant.orgId))
        .for("update");
      const outcome = orgCreditExpirationOutcome(
        parseRawRows(
          orgCreditExpirationOutcomeRow,
          await tx.execute(orgCreditExpirationSql(grant.orgId, at)),
        ),
      );
      // A fresh statement snapshot: a concurrent clear or extension that
      // leaves no expired remainder is benign.
      const [remaining] =
        outcome.cleared === outcome.expected
          ? []
          : await tx
              .select()
              .from(pendingOrgCreditExpirationQuery(grant.orgId, at));
      requireCompleteOrgCreditExpiration(grant.orgId, outcome, remaining);
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
