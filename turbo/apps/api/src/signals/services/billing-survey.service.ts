import type {
  BillingSurveyKind,
  BillingSurveyRequest,
} from "@okouai/api-contracts/contracts/billing";
import { billingSurveyResponses } from "@okouai/db/schema/billing-survey-response";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { number, object } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

/** About one task's worth of credits, granted once per organization. */
export const CREDITS_EXHAUSTED_SURVEY_REWARD = 200;

const REWARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAID_TIERS = ["pro", "team", "custom"] as const;

interface RecordBillingSurveyArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly request: BillingSurveyRequest;
}

const recordBillingSurveyRow = object({
  recorded: number().int(),
  rewardCredits: number().int(),
});

export function billingSurveyRewardIdempotencyKey(orgId: string): string {
  return `billing-survey:credits_exhausted:${orgId}`;
}

/**
 * One statement records the answer and, for the credits-exhausted survey on an
 * unpaid organization, grants the thank-you credits. The grant only follows a
 * newly inserted answer, and its organization-scoped idempotency key keeps it
 * to one grant per organization even when several members answer at once.
 */
export function recordBillingSurveySql(args: RecordBillingSurveyArgs) {
  const { orgId, userId, request } = args;
  const amount = CREDITS_EXHAUSTED_SURVEY_REWARD;
  const idempotencyKey = billingSurveyRewardIdempotencyKey(orgId);
  const expiresAt = new Date(nowDate().getTime() + REWARD_TTL_MS);
  const checkoutKind =
    request.survey === "checkout_abandoned"
      ? (request.checkoutKind ?? null)
      : null;
  const rewardable = request.survey === "credits_exhausted";
  const paidTiers = sql.join(
    PAID_TIERS.map((tier) => {
      return sql`${tier}`;
    }),
    sql`, `,
  );
  return sql`WITH eligible AS (
      SELECT (${rewardable}::boolean
        AND NOT EXISTS (
          SELECT 1 FROM ${orgMetadata}
          WHERE ${orgMetadata.orgId} = ${orgId} AND ${orgMetadata.tier} IN (${paidTiers})
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${usagePackCreditGrants}
          WHERE ${usagePackCreditGrants.idempotencyKey} = ${idempotencyKey}
        )) AS ok
    ),
    response AS (
      INSERT INTO ${billingSurveyResponses}
        (org_id, user_id, survey, answer, detail, checkout_kind, reward_credits)
      SELECT ${orgId}, ${userId}, ${request.survey}, ${request.answer},
        ${request.detail ?? null}, ${checkoutKind},
        CASE WHEN eligible.ok THEN ${amount}::integer ELSE 0 END
      FROM eligible
      ON CONFLICT (org_id, user_id, survey) DO NOTHING
      RETURNING reward_credits
    ),
    credit AS (
      INSERT INTO ${usagePackCreditGrants}
        (org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at)
      SELECT ${orgId}, ${userId}, 'bonus', ${idempotencyKey}, ${amount}, ${amount},
        ${sql.param(expiresAt, usagePackCreditGrants.expiresAt)}
      FROM response WHERE response.reward_credits > 0
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING original_amount
    )
    SELECT
      (SELECT count(*) FROM response)::integer AS "recorded",
      COALESCE((SELECT sum(original_amount) FROM credit), 0)::integer AS "rewardCredits"`;
}

export const recordBillingSurvey$ = command(
  async (
    { set },
    args: RecordBillingSurveyArgs,
    signal: AbortSignal,
  ): Promise<{
    readonly recorded: boolean;
    readonly rewardCredits: number;
  }> => {
    const writeDb = set(writeDb$);
    const [row] = parseRawRows(
      recordBillingSurveyRow,
      await writeDb.execute(recordBillingSurveySql(args)),
    );
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Billing survey record did not return its outcome");
    }
    return { recorded: row.recorded > 0, rewardCredits: row.rewardCredits };
  },
);

export const answeredBillingSurveys$ = command(
  async (
    { get },
    args: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<readonly BillingSurveyKind[]> => {
    const rows = await get(db$)
      .select({ survey: billingSurveyResponses.survey })
      .from(billingSurveyResponses)
      .where(
        and(
          eq(billingSurveyResponses.orgId, args.orgId),
          eq(billingSurveyResponses.userId, args.userId),
        ),
      );
    signal.throwIfAborted();
    return rows.map((row) => {
      return row.survey;
    });
  },
);
