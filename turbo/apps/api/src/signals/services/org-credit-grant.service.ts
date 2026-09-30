import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { orgPlanEntitlementValues } from "./org-plan-entitlements.service";
import {
  OrgCreditExpirationRequired,
  pendingOrgCreditExpirationQuery,
} from "./org-credit-expiration";
import { expireOrgCredits$ } from "./org-credit-expiration.service";

interface OrgCreditGrant {
  readonly orgId: string;
  readonly source: string;
  readonly stripeInvoiceId: string;
  readonly amount: number;
  readonly expiresAt: Date;
  readonly clearAutoRechargePending?: boolean;
}

/** The unique grant identity and its wallet increment commit together. */
export const grantPurchasedOrgCredits$ = command(
  async (
    { set },
    grant: OrgCreditGrant,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    for (let attempt = 0; attempt < 4; attempt++) {
      const complete = await db.transaction(async (tx) => {
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
        // No wallet row lock: the unique invoice receipt admits one increment,
        // and the increment is atomic arithmetic. An expiration that has not
        // committed still shows its expired remainder here, so this adder
        // retries after it instead of interleaving with a partial clamp.
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
          return true;
        }
        const [expired] = await tx
          .select()
          .from(pendingOrgCreditExpirationQuery(grant.orgId, nowDate()));
        if (expired) {
          return false;
        }
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
          return true;
        }
        await tx
          .update(orgMetadata)
          .set({
            credits: sql`${orgMetadata.credits} + ${grant.amount}`,
            ...(grant.clearAutoRechargePending
              ? { autoRechargePendingAt: null }
              : {}),
            updatedAt: nowDate(),
          })
          .where(eq(orgMetadata.orgId, grant.orgId));

        signal.throwIfAborted();
        return true;
      });
      signal.throwIfAborted();
      if (complete) {
        return;
      }
      await set(expireOrgCredits$, grant.orgId, signal);
    }
    throw new OrgCreditExpirationRequired(grant.orgId);
  },
);
