import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command, computed } from "ccstate";
import { and, eq, gt, inArray, lte, notExists, sql, sum } from "drizzle-orm";
import { boolean, number, object } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { rawSqlReadDb$, writeDb$ } from "../external/db";

export const BILLING_FEEDBACK_REWARD_CREDITS = 200;
const PAID_TIERS = ["pro", "team"] as const;

function feedbackRewardIdempotencyKey(orgId: string): string {
  // Retain the financial identity independently of questionnaire storage.
  return `billing-survey:credits_exhausted:${orgId}`;
}

function rewardEligibilitySql(
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly canManageBilling: boolean;
  },
  at: Date,
) {
  const expired = sql`(SELECT COALESCE(${sum(creditExpiresRecord.remaining)}, 0)
    FROM ${creditExpiresRecord}
    WHERE ${and(
      eq(creditExpiresRecord.orgId, args.orgId),
      gt(creditExpiresRecord.remaining, 0),
      lte(creditExpiresRecord.expiresAt, at),
    )})`;
  return sql`${args.canManageBilling}::boolean AND ${and(
    notExists(
      sql`(SELECT 1 FROM ${orgMetadata} WHERE ${and(
        eq(orgMetadata.orgId, args.orgId),
        inArray(orgMetadata.tier, PAID_TIERS),
      )})`,
    ),
    notExists(
      sql`(SELECT 1 FROM ${orgMetadata} WHERE ${and(
        eq(orgMetadata.orgId, args.orgId),
        gt(sql`${orgMetadata.credits} - ${expired}`, 0),
      )})`,
    ),
    notExists(
      sql`(SELECT 1 FROM ${usagePackCreditGrants} WHERE ${and(
        eq(usagePackCreditGrants.orgId, args.orgId),
        eq(usagePackCreditGrants.userId, args.userId),
        gt(usagePackCreditGrants.remainingAmount, 0),
        gt(usagePackCreditGrants.expiresAt, at),
      )})`,
    ),
    notExists(
      sql`(SELECT 1 FROM ${usagePackCreditGrants} WHERE ${eq(
        usagePackCreditGrants.idempotencyKey,
        feedbackRewardIdempotencyKey(args.orgId),
      )})`,
    ),
  )}`;
}

export function billingFeedbackRewardEligible(identity: {
  readonly orgId: string;
  readonly userId: string;
  readonly canManageBilling: boolean;
}) {
  return computed(async (get) => {
    const [row] = parseRawRows(
      object({ eligible: boolean() }),
      await get(rawSqlReadDb$).execute(
        sql`SELECT ${rewardEligibilitySql(identity, nowDate())} AS eligible`,
      ),
    );
    if (!row) {
      throw new Error("Feedback reward eligibility did not return its outcome");
    }
    return row.eligible;
  });
}

/** A financial grant only. Answers stay in PostHog; the ledger deduplicates per org. */
export const grantBillingFeedbackReward$ = command(
  async (
    { set },
    identity: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const at = nowDate();
    const expiresAt = new Date(at.getTime() + 30 * 24 * 60 * 60 * 1000);
    const rows = parseRawRows(
      object({ amount: number().int() }),
      await set(writeDb$).execute(sql`
        INSERT INTO ${usagePackCreditGrants}
          (org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at)
        SELECT ${identity.orgId}, ${identity.userId}, 'bonus',
          ${feedbackRewardIdempotencyKey(identity.orgId)},
          ${BILLING_FEEDBACK_REWARD_CREDITS}, ${BILLING_FEEDBACK_REWARD_CREDITS},
          ${sql.param(expiresAt, usagePackCreditGrants.expiresAt)}
        WHERE ${rewardEligibilitySql({ ...identity, canManageBilling: true }, at)}
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING original_amount::integer AS amount`),
    );
    signal.throwIfAborted();
    return rows[0]?.amount ?? 0;
  },
);
