import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import {
  and,
  eq,
  getTableColumns,
  gt,
  isNull,
  notExists,
  SQL,
  sql,
  type Column,
} from "drizzle-orm";
import { alias, PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import {
  morningBriefScheduleClaims,
  type MorningBriefScheduleClaimSettlement,
} from "@okouai/db/schema/morning-brief-schedule-claim";
import { scheduleFailurePauseValues } from "./workflow-schedule-failure-policy";

type ScheduleInputs = Pick<
  typeof workflowAutomations.$inferSelect,
  "scheduleType" | "cronExpression" | "intervalSeconds" | "timezone"
>;

export interface InFlightScheduleAdvance {
  readonly automationId: string;
  /** The recurrence the successor below was computed from. */
  readonly read: ScheduleInputs & { readonly scheduleType: "cron" | "loop" };
  readonly automationValues: {
    readonly consecutiveFailures: number;
    readonly enabled?: boolean;
    readonly nextRunAt: Date | null;
    readonly updatedAt: Date;
  };
  /** Ordinary callbacks count the committed value, not their read snapshot. */
  readonly ordinaryFailure?: {
    readonly reset: boolean;
    readonly increment: number;
    readonly disableAt: number;
  };
  readonly at: Date;
  /** Only an empty (in-flight) slot may be advanced; a published one wins. */
  readonly requireEmptySlot: boolean;
  /** A pre-journal callback cannot publish into a journaled execution lineage. */
  readonly requireUnjournaledSlot?: boolean;
}

/**
 * Statement data only; each caller owns rollback in its existing transaction.
 * A zero-row UPDATE may retain tuple locks until that outer transaction ends.
 */
export function inFlightScheduleAdvanceValues(args: InFlightScheduleAdvance) {
  const ordinary = args.ordinaryFailure;
  const nextCount = ordinary?.reset
    ? sql`0`
    : sql`${workflowAutomations.consecutiveFailures} + ${ordinary?.increment ?? 0}`;
  const disable =
    ordinary && !ordinary.reset && ordinary.increment > 0
      ? sql`${nextCount} >= ${ordinary.disableAt}`
      : sql`false`;
  return {
    ...args.automationValues,
    ...(ordinary
      ? {
          consecutiveFailures: nextCount,
          ...scheduleFailurePauseValues(
            disable,
            args.automationValues.nextRunAt,
          ),
        }
      : {}),
  };
}

export function inFlightScheduleAdvanceCondition(
  args: InFlightScheduleAdvance,
) {
  return and(
    eq(workflowAutomations.id, args.automationId),
    eq(workflowAutomations.enabled, true),
    args.requireEmptySlot ? isNull(workflowAutomations.nextRunAt) : undefined,
    args.requireUnjournaledSlot
      ? sql`NOT EXISTS (SELECT 1 FROM morning_brief_schedule_claims WHERE automation_id = ${args.automationId}::uuid)`
      : undefined,
  );
}

export const MORNING_BRIEF_SETTLEMENT_CLAIM_LOST = "tx0189_claim_lost";

interface MorningBriefSettlementClaimIdentity {
  readonly automationId: string;
  readonly claimId: string;
  readonly claimSequence: number;
}

interface MorningBriefSettlementPublication extends MorningBriefSettlementClaimIdentity {
  readonly automationRevision: string;
  readonly settlement: Exclude<
    MorningBriefScheduleClaimSettlement,
    "unsettled"
  >;
  readonly settledAt: Date;
  readonly advance: InFlightScheduleAdvance | null;
}

export function morningBriefScheduleSettlementClaimCondition(
  args: MorningBriefSettlementClaimIdentity,
) {
  const newer = alias(
    morningBriefScheduleClaims,
    "newer_morning_settlement_claim",
  );
  return and(
    eq(morningBriefScheduleClaims.id, args.claimId),
    eq(morningBriefScheduleClaims.automationId, args.automationId),
    eq(morningBriefScheduleClaims.claimSequence, args.claimSequence),
    eq(morningBriefScheduleClaims.settlement, "unsettled"),
    notExists(
      new QueryBuilder()
        .select({ id: newer.id })
        .from(newer)
        .where(
          and(
            eq(newer.automationId, args.automationId),
            gt(newer.claimSequence, args.claimSequence),
          ),
        ),
    ),
  );
}

function morningBriefSettlementAdvanceSql(
  args: MorningBriefSettlementPublication,
  advance: InFlightScheduleAdvance,
): SQL {
  const columns: Readonly<Record<string, Column>> =
    getTableColumns(workflowAutomations);
  const values = inFlightScheduleAdvanceValues(advance);
  const fields = Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    const column = columns[key];
    if (!column) {
      throw new Error("Morning Brief settlement contains an unknown column");
    }
    return [[key, value instanceof SQL ? value : sql.param(value, column)]];
  });
  return new PgDialect().buildUpdateQuery({
    table: workflowAutomations,
    set: Object.fromEntries(fields),
    joins: [],
    where: and(
      inFlightScheduleAdvanceCondition(advance),
      eq(workflowAutomations.id, args.automationId),
      sql`${workflowAutomations}.xmin::text = ${args.automationRevision}`,
      sql`EXISTS (SELECT 1 FROM morning_settlement_candidate)`,
    ),
    returning: [{ path: ["id"], field: workflowAutomations.id }],
  });
}

/** The claim CAS owns settlement; a lost CAS rolls back the attempted advance. */
export function morningBriefScheduleSettlementPublicationSql(
  args: MorningBriefSettlementPublication,
): SQL {
  const query = new QueryBuilder();
  const candidate = query
    .select({ id: morningBriefScheduleClaims.id })
    .from(morningBriefScheduleClaims)
    .where(morningBriefScheduleSettlementClaimCondition(args))
    .limit(1)
    .getSQL();
  const current = query
    .select({ id: workflowAutomations.id })
    .from(workflowAutomations)
    .where(
      and(
        eq(workflowAutomations.id, args.automationId),
        sql`${workflowAutomations}.xmin::text = ${args.automationRevision}`,
      ),
    )
    .limit(1)
    .getSQL();
  const advance = args.advance
    ? morningBriefSettlementAdvanceSql(args, args.advance)
    : query
        .select({ id: workflowAutomations.id })
        .from(workflowAutomations)
        .where(sql`false`)
        .getSQL();
  const admitted = args.advance
    ? sql`EXISTS (SELECT 1 FROM morning_settlement_advanced)`
    : sql`EXISTS (SELECT 1 FROM morning_settlement_current)`;
  return sql`WITH morning_settlement_candidate AS MATERIALIZED (${candidate}),
    morning_settlement_current AS MATERIALIZED (${current}),
    morning_settlement_advanced AS (${advance}),
    morning_settlement_claim AS (
      UPDATE ${morningBriefScheduleClaims}
      SET settlement = ${sql.param(args.settlement, morningBriefScheduleClaims.settlement)},
        settled_at = ${sql.param(args.settledAt, morningBriefScheduleClaims.settledAt)},
        updated_at = ${sql.param(args.settledAt, morningBriefScheduleClaims.updatedAt)}
      WHERE ${morningBriefScheduleClaims.id} IN (SELECT id FROM morning_settlement_candidate)
        AND ${eq(morningBriefScheduleClaims.settlement, "unsettled")}
        AND ${admitted}
      RETURNING id
    )
    SELECT EXISTS (SELECT 1 FROM morning_settlement_candidate) AS candidate_present,
      EXISTS (SELECT 1 FROM morning_settlement_current) AS automation_current,
      EXISTS (SELECT 1 FROM morning_settlement_advanced) AS advanced,
      EXISTS (SELECT 1 FROM morning_settlement_claim) AS settled,
      (CASE WHEN EXISTS (SELECT 1 FROM morning_settlement_advanced)
        AND NOT EXISTS (SELECT 1 FROM morning_settlement_claim)
        THEN ${MORNING_BRIEF_SETTLEMENT_CLAIM_LOST} ELSE '0' END)::integer AS assertion`;
}
