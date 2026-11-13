import type {
  BillingSurveyKind,
  BillingSurveyRequest,
} from "@okouai/api-contracts/contracts/billing";
import { billingSurveyResponses } from "@okouai/db/schema/billing-survey-response";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { command } from "ccstate";
import { and, eq, gt, inArray, lte, notExists, sql, sum } from "drizzle-orm";
import { number, object } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { db$, rawSqlReadDb$, writeDb$ } from "../external/db";

/** About one task's worth of credits, granted once per organization. */
const CREDITS_EXHAUSTED_SURVEY_REWARD = 200;

const REWARD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAID_TIERS = ["pro", "team"] as const;

interface RecordBillingSurveyArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly request: BillingSurveyRequest;
  readonly canManageBilling: boolean;
}

const recordBillingSurveyRow = object({
  recorded: number().int(),
  rewardCredits: number().int(),
});

function billingSurveyRewardIdempotencyKey(orgId: string): string {
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
        billingSurveyRewardIdempotencyKey(args.orgId),
      )})`,
    ),
    notExists(
      sql`(SELECT 1 FROM ${billingSurveyResponses} WHERE ${and(
        eq(billingSurveyResponses.orgId, args.orgId),
        eq(billingSurveyResponses.userId, args.userId),
        eq(billingSurveyResponses.survey, "credits_exhausted"),
      )})`,
    ),
  )}`;
}

export const creditsExhaustedSurveyReward$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly canManageBilling: boolean;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const [row] = parseRawRows(
      object({ reward: number().int() }),
      await get(rawSqlReadDb$)
        .execute(sql`SELECT CASE WHEN ${rewardEligibilitySql(args, nowDate())}
        THEN ${CREDITS_EXHAUSTED_SURVEY_REWARD}::integer ELSE 0 END AS reward`),
    );
    signal.throwIfAborted();
    if (!row) {
      throw new Error("Billing survey eligibility did not return its outcome");
    }
    return row.reward;
  },
);

/**
 * The unique organization grant selects the reward winner before recording
 * the answer, so reward_credits records actual issuance even across members.
 * Both writes commit together; a repeated answer cannot create a new grant.
 */
function recordBillingSurveySql(args: RecordBillingSurveyArgs) {
  const { orgId, userId, request } = args;
  const amount = CREDITS_EXHAUSTED_SURVEY_REWARD;
  const at = nowDate();
  const expiresAt = new Date(at.getTime() + REWARD_TTL_MS);
  const checkoutKind =
    request.survey === "checkout_abandoned"
      ? (request.checkoutKind ?? null)
      : null;
  return sql`WITH credit AS (
      INSERT INTO ${usagePackCreditGrants}
        (org_id, user_id, grant_type, idempotency_key, original_amount, remaining_amount, expires_at)
      SELECT ${orgId}, ${userId}, 'bonus', ${billingSurveyRewardIdempotencyKey(orgId)},
        ${amount}, ${amount}, ${sql.param(expiresAt, usagePackCreditGrants.expiresAt)}
      WHERE ${request.survey === "credits_exhausted"}::boolean
        AND ${rewardEligibilitySql(args, at)}
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING original_amount
    ), response AS (
      INSERT INTO ${billingSurveyResponses}
        (org_id, user_id, survey, answer, detail, checkout_kind, reward_credits)
      VALUES (${orgId}, ${userId}, ${request.survey}, ${request.answer},
        ${request.answer === "other" ? (request.detail ?? null) : null}, ${checkoutKind},
        COALESCE((SELECT original_amount FROM credit), 0))
      ON CONFLICT (org_id, user_id, survey) DO NOTHING
      RETURNING reward_credits
    )
    SELECT (SELECT count(*) FROM response)::integer AS "recorded",
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
