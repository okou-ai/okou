import { randomUUID } from "node:crypto";
import { FRIEND_REFERRAL_REWARD_CREDITS } from "@okouai/api-contracts/contracts/friend-referrals";
import { GET_STARTED_REWARDS_CHANGED_EVENT } from "@okouai/api-contracts/validators/get-started";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import {
  friendReferralLinks,
  friendReferrals,
} from "@okouai/db/schema/friend-referral";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePackCreditRefunds } from "@okouai/db/schema/usage-pack-credit-refund";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import type { StripeInvoice } from "../external/stripe-client";
import { publishUserSignal } from "../external/realtime";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";

export const friendReferralsEnabled$ = command(
  async ({ set }, orgId: string, userId: string, signal: AbortSignal) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      orgId,
      userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.FriendReferrals, context);
  },
);

/** Only credits fulfilled from this paid invoice qualify, never a plan-only upgrade. */
export const grantPaidFriendReferralRewards$ = command(
  async (
    { set },
    invoice: Pick<StripeInvoice, "id" | "amount_paid"> & {
      readonly customer: string | { readonly id: string } | null;
      readonly status?: StripeInvoice["status"];
      readonly currency?: string;
      readonly paid_out_of_band?: boolean;
    },
    orgId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (
      invoice.status !== "paid" ||
      !Number.isSafeInteger(invoice.amount_paid) ||
      invoice.amount_paid <= 0 ||
      invoice.currency !== "usd" ||
      invoice.paid_out_of_band ||
      !invoice.customer
    ) {
      return;
    }
    const db = set(writeDb$);
    const at = nowDate();
    const customerId =
      typeof invoice.customer === "string"
        ? invoice.customer
        : invoice.customer.id;
    const eligible = db
      .select({
        inviteeUserId: friendReferrals.inviteeUserId,
        linkId: friendReferralLinks.id,
        orgId: friendReferralLinks.orgId,
        userId: friendReferralLinks.userId,
      })
      .from(friendReferrals)
      .innerJoin(
        friendReferralLinks,
        eq(friendReferralLinks.id, friendReferrals.linkId),
      )
      .innerJoin(
        usagePackCreditRefunds,
        eq(usagePackCreditRefunds.userId, friendReferrals.inviteeUserId),
      )
      .innerJoin(
        usagePackCreditGrants,
        eq(usagePackCreditGrants.id, usagePackCreditRefunds.creditGrantId),
      )
      .innerJoin(
        orgPlanEntitlements,
        eq(orgPlanEntitlements.orgId, usagePackCreditRefunds.orgId),
      )
      .innerJoin(
        orgMetadata,
        eq(orgMetadata.orgId, usagePackCreditRefunds.orgId),
      )
      .where(
        and(
          isNull(friendReferrals.grantedAt),
          eq(usagePackCreditRefunds.orgId, orgId),
          eq(usagePackCreditRefunds.stripeInvoiceId, invoice.id),
          eq(usagePackCreditRefunds.status, "available"),
          gt(usagePackCreditRefunds.sourceAmountCents, 0),
          eq(usagePackCreditGrants.grantType, "purchased"),
          gt(usagePackCreditGrants.originalAmount, 0),
          eq(orgMetadata.stripeCustomerId, customerId),
          inArray(orgPlanEntitlements.planKey, ["pro", "team"]),
          eq(orgPlanEntitlements.status, "active"),
          or(
            isNull(orgPlanEntitlements.expiresAt),
            gt(orgPlanEntitlements.expiresAt, at),
          ),
        ),
      );
    const candidates = await eligible;
    signal.throwIfAborted();
    for (const candidate of candidates) {
      if (
        !(await set(
          friendReferralsEnabled$,
          candidate.orgId,
          candidate.userId,
          signal,
        ))
      ) {
        continue;
      }
      const membership = await set(
        getMemberRoleAndUpdateCache$,
        candidate.orgId,
        candidate.userId,
        signal,
      );
      if (membership.kind !== "member") {
        continue;
      }
      const grantId = randomUUID();
      const accepted = eligible.as("eligible_referral");
      // The conditional UPDATE owns the unique referred-user identity. Its bonus
      // grant commits in the same statement; a competing delivery returns no row.
      const { rowCount } = await db.execute(sql`WITH rewarded AS (
      UPDATE ${friendReferrals} SET paid_org_id = ${orgId}, stripe_invoice_id = ${invoice.id},
        credit_grant_id = ${grantId}::uuid,
        granted_at = ${sql.param(at, friendReferrals.grantedAt)},
        expires_at = ${sql.param(at, friendReferrals.grantedAt)}::timestamp + interval '1 month'
      WHERE ${friendReferrals.inviteeUserId} = ${candidate.inviteeUserId}
        AND ${friendReferrals.linkId} = ${candidate.linkId}::uuid AND ${friendReferrals.grantedAt} IS NULL
        AND EXISTS (SELECT 1 FROM ${accepted} WHERE ${accepted.inviteeUserId} = ${candidate.inviteeUserId})
      RETURNING ${friendReferrals.inviteeUserId}
    ) INSERT INTO ${usagePackCreditGrants}
      (id, org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at, created_at)
      SELECT ${grantId}::uuid, ${candidate.orgId}, ${candidate.userId}, 'bonus',
        ${`friend-referral:${candidate.inviteeUserId}`}, ${FRIEND_REFERRAL_REWARD_CREDITS}, ${FRIEND_REFERRAL_REWARD_CREDITS},
        ${sql.param(at, usagePackCreditGrants.expiresAt)}::timestamp + interval '1 month',
        ${sql.param(at, usagePackCreditGrants.createdAt)} FROM rewarded`);
      signal.throwIfAborted();
      if (rowCount === 1) {
        await publishUserSignal(
          [candidate.userId],
          GET_STARTED_REWARDS_CHANGED_EVENT,
        );
        signal.throwIfAborted();
      }
    }
  },
);
