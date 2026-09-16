import { usageAllowanceAllocations } from "@okouai/db/schema/org-usage-allowance";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { command } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  executeRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { timestampWithoutTimeZone } from "../../lib/time";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";

const L = logger("CronCompactUsageEvents");
const USAGE_EVENT_COMPACTION_RAW_SEED_LIMIT = 500;
const event = alias(usageEvent, "event");
const allocation = alias(usageAllowanceAllocations, "allocation");
const hourly = alias(usageEventHourlyRollup, "hourly");

type UsageEventCompactionDb = Pick<Db, "execute" | "transaction">;

interface UsageEventCompactionStats {
  readonly cutoff: string;
  readonly rawSeedLimit: number;
  readonly seededRawRows: number;
  readonly selectedGrains: number;
  readonly probedRawRows: number;
  readonly billingErrorHeldRows: number;
  readonly rawRowsDeleted: number;
  readonly hourlyRowsDeleted: number;
  readonly hourlyRowsInserted: number;
  readonly quantity: string;
  readonly nonDeduplicatedQuantity: string;
  readonly creditsCharged: string;
  readonly allowanceUnits: string;
  readonly affectedShortWindows: number;
  readonly affectedWeeklyWindows: number;
  readonly reconciled: boolean;
  readonly hasMore: boolean;
  readonly lockWaitMs: number;
  readonly durationMs: number;
}

const integerTextSchema = z.string().regex(/^-?\d+$/);

const cutoffRowSchema = z.object({
  cutoff: pgTimestampWithoutTimezoneToDateSchema,
});

const holdProbeRowSchema = z.object({
  probedRawRows: z.int(),
  billingErrorHeldRows: z.int(),
});

const compactionRowSchema = z.object({
  seededRawRows: z.int(),
  selectedGrains: z.int(),
  rawRowsDeleted: z.int(),
  hourlyRowsDeleted: z.int(),
  hourlyRowsInserted: z.int(),
  quantity: integerTextSchema,
  nonDeduplicatedQuantity: integerTextSchema,
  creditsCharged: integerTextSchema,
  allowanceUnits: integerTextSchema,
  affectedShortWindows: z.int(),
  affectedWeeklyWindows: z.int(),
  reconciled: z.boolean(),
});

// The explicit null order matches a reverse scan of the deployed
// idx_usage_event_processed_org_user index. Eligible rows are always non-null.
const oldestProcessedEventOrder = sql`${asc(event.processedAt)} NULLS FIRST`;

function eligibleRawPredicate(cutoff: string, orgId?: string): SQL {
  return sql`${and(
    eq(event.status, sql`'processed'`),
    orgId === undefined ? undefined : eq(event.orgId, orgId),
    isNotNull(event.processedAt),
    lt(event.processedAt, sql`${cutoff}::timestamp`),
    isNull(event.billingError),
  )}`;
}

function billingGrainColumns(alias: string): SQL {
  const source = sql.identifier(alias);
  return sql`${source}.billing_run_id, ${source}.billing_anchor_at, ${source}.billing_context`;
}

function billingGrainPredicate(source: typeof event | typeof hourly) {
  return and(
    sql`${source.billingRunId} IS NOT DISTINCT FROM grain.billing_run_id`,
    sql`${source.billingAnchorAt} IS NOT DISTINCT FROM grain.billing_anchor_at`,
    eq(source.billingContext, sql`grain.billing_context`),
  );
}

function physicalGrainColumns(alias: string): SQL {
  const source = sql.identifier(alias);
  return sql`
    ${source}.processed_hour,
    ${source}.org_id,
    ${source}.user_id,
    ${source}.run_id,
    ${billingGrainColumns(alias)},
    ${source}.kind,
    ${source}.provider,
    ${source}.category,
    ${source}.short_window_id,
    ${source}.weekly_window_id
  `;
}

function physicalGrainOrder(alias: string): SQL {
  const source = sql.identifier(alias);
  return sql`
    ${source}.processed_hour ASC,
    ${source}.org_id ASC,
    ${source}.user_id ASC,
    ${source}.run_id ASC NULLS FIRST,
    ${source}.billing_run_id ASC NULLS FIRST,
    ${source}.billing_anchor_at ASC NULLS FIRST,
    ${source}.billing_context ASC,
    ${source}.kind ASC,
    ${source}.provider ASC,
    ${source}.category ASC,
    ${source}.short_window_id ASC NULLS FIRST,
    ${source}.weekly_window_id ASC NULLS FIRST
  `;
}

function candidateCtes(args: {
  readonly cutoff: string;
  readonly rawSeedLimit: number;
  readonly orgId: string | undefined;
}): SQL {
  return sql`
    raw_seed AS MATERIALIZED (
      SELECT
        event.id,
        date_trunc('hour', event.processed_at)::timestamp AS processed_hour,
        event.org_id,
        event.user_id,
        event.run_id,
        ${billingGrainColumns("event")},
        event.kind,
        event.provider,
        event.category,
        allocation.short_window_id,
        allocation.weekly_window_id
      FROM ${usageEvent} ${event}
      LEFT JOIN ${usageAllowanceAllocations} ${allocation}
        ON ${eq(allocation.usageEventId, event.id)}
      WHERE ${eligibleRawPredicate(args.cutoff, args.orgId)}
      ORDER BY ${oldestProcessedEventOrder}
      LIMIT ${args.rawSeedLimit}
      FOR UPDATE OF event
    ),
    raw_seed_grains AS MATERIALIZED (
      SELECT DISTINCT ${physicalGrainColumns("raw_seed")}
      FROM raw_seed
    ),
    selected_grains AS MATERIALIZED (
      SELECT ${physicalGrainColumns("raw_seed_grains")}
      FROM raw_seed_grains
      ORDER BY ${physicalGrainOrder("raw_seed_grains")}
    )
  `;
}

function lockedSourceCtes(cutoff: string): SQL {
  return sql`
    locked_raw_events AS MATERIALIZED (
      SELECT
        event.id,
        grain.processed_hour,
        event.org_id,
        event.user_id,
        event.run_id,
        ${billingGrainColumns("event")},
        event.kind,
        event.provider,
        event.category,
        grain.short_window_id,
        grain.weekly_window_id,
        event.quantity,
        event.non_deduplicated_quantity,
        COALESCE(event.credits_charged, 0)::bigint AS credits_charged
      FROM selected_grains grain
      INNER JOIN ${usageEvent} ${event}
        ON ${and(
          gte(event.processedAt, sql`grain.processed_hour`),
          lt(event.processedAt, sql`grain.processed_hour + interval '1 hour'`),
          eq(event.orgId, sql`grain.org_id`),
          eq(event.userId, sql`grain.user_id`),
          sql`${event.runId} IS NOT DISTINCT FROM grain.run_id`,
          billingGrainPredicate(event),
          eq(event.kind, sql`grain.kind`),
          eq(event.provider, sql`grain.provider`),
          eq(event.category, sql`grain.category`),
        )}
      LEFT JOIN ${usageAllowanceAllocations} ${allocation}
        ON ${eq(allocation.usageEventId, event.id)}
      WHERE ${and(
        eligibleRawPredicate(cutoff),
        sql`${allocation.shortWindowId} IS NOT DISTINCT FROM grain.short_window_id`,
        sql`${allocation.weeklyWindowId} IS NOT DISTINCT FROM grain.weekly_window_id`,
      )}
      FOR UPDATE OF event
    ),
    locked_raw_allocations AS MATERIALIZED (
      SELECT
        allocation.usage_event_id,
        allocation.units_applied
      FROM locked_raw_events event
      INNER JOIN ${usageAllowanceAllocations} ${allocation}
        ON ${eq(allocation.usageEventId, sql`event.id`)}
      FOR UPDATE OF allocation
    ),
    locked_raw AS MATERIALIZED (
      SELECT
        event.id,
        event.processed_hour,
        event.org_id,
        event.user_id,
        event.run_id,
        ${billingGrainColumns("event")},
        event.kind,
        event.provider,
        event.category,
        event.short_window_id,
        event.weekly_window_id,
        event.quantity,
        event.non_deduplicated_quantity,
        event.credits_charged,
        COALESCE(allocation.units_applied, 0)::bigint AS allowance_units
      FROM locked_raw_events event
      LEFT JOIN locked_raw_allocations allocation
        ON allocation.usage_event_id = event.id
    ),
    locked_hourly AS MATERIALIZED (
      SELECT
        hourly.id,
        hourly.processed_hour,
        hourly.org_id,
        hourly.user_id,
        hourly.run_id,
        ${billingGrainColumns("hourly")},
        hourly.kind,
        hourly.provider,
        hourly.category,
        hourly.short_window_id,
        hourly.weekly_window_id,
        hourly.quantity,
        hourly.non_deduplicated_quantity,
        hourly.credits_charged,
        hourly.allowance_units
      FROM selected_grains grain
      INNER JOIN ${usageEventHourlyRollup} ${hourly}
        ON ${and(
          eq(hourly.processedHour, sql`grain.processed_hour`),
          eq(hourly.orgId, sql`grain.org_id`),
          eq(hourly.userId, sql`grain.user_id`),
          sql`${hourly.runId} IS NOT DISTINCT FROM grain.run_id`,
          billingGrainPredicate(hourly),
          eq(hourly.kind, sql`grain.kind`),
          eq(hourly.provider, sql`grain.provider`),
          eq(hourly.category, sql`grain.category`),
          sql`${hourly.shortWindowId} IS NOT DISTINCT FROM grain.short_window_id`,
          sql`${hourly.weeklyWindowId} IS NOT DISTINCT FROM grain.weekly_window_id`,
        )}
      FOR UPDATE OF hourly
    )
  `;
}

function consolidatedSourceCtes(): SQL {
  return sql`
    source_facts AS MATERIALIZED (
      SELECT
        ${physicalGrainColumns("locked_raw")},
        locked_raw.quantity::numeric AS quantity,
        locked_raw.non_deduplicated_quantity::numeric AS non_deduplicated_quantity,
        locked_raw.credits_charged::numeric AS credits_charged,
        locked_raw.allowance_units::numeric AS allowance_units
      FROM locked_raw

      UNION ALL

      SELECT
        ${physicalGrainColumns("locked_hourly")},
        locked_hourly.quantity::numeric AS quantity,
        locked_hourly.non_deduplicated_quantity::numeric AS non_deduplicated_quantity,
        locked_hourly.credits_charged::numeric AS credits_charged,
        locked_hourly.allowance_units::numeric AS allowance_units
      FROM locked_hourly
    ),
    consolidated AS MATERIALIZED (
      SELECT
        ${physicalGrainColumns("source_facts")},
        SUM(source_facts.quantity) AS quantity,
        SUM(source_facts.non_deduplicated_quantity) AS non_deduplicated_quantity,
        SUM(source_facts.credits_charged) AS credits_charged,
        SUM(source_facts.allowance_units) AS allowance_units
      FROM source_facts
      GROUP BY ${physicalGrainColumns("source_facts")}
    )
  `;
}

function mutationCtes(): SQL {
  return sql`
    deleted_hourly AS (
      DELETE FROM ${usageEventHourlyRollup} ${hourly}
      USING locked_hourly
      WHERE ${eq(hourly.id, sql`locked_hourly.id`)}
      RETURNING hourly.id
    ),
    inserted_hourly AS (
      INSERT INTO ${usageEventHourlyRollup} (
        processed_hour,
        org_id,
        user_id,
        run_id,
        billing_run_id,
        billing_anchor_at,
        billing_context,
        kind,
        provider,
        category,
        short_window_id,
        weekly_window_id,
        quantity,
        non_deduplicated_quantity,
        credits_charged,
        allowance_units
      )
      SELECT
        ${physicalGrainColumns("consolidated")},
        consolidated.quantity,
        consolidated.non_deduplicated_quantity,
        consolidated.credits_charged,
        consolidated.allowance_units
      FROM consolidated
      RETURNING
        processed_hour,
        org_id,
        user_id,
        run_id,
        billing_run_id,
        billing_anchor_at,
        billing_context,
        kind,
        provider,
        category,
        short_window_id,
        weekly_window_id,
        quantity,
        non_deduplicated_quantity,
        credits_charged,
        allowance_units
    ),
    deleted_raw AS (
      DELETE FROM ${usageEvent} ${event}
      USING locked_raw
      WHERE ${and(
        eq(event.id, sql`locked_raw.id`),
        eq(event.status, sql`'processed'`),
      )}
      RETURNING event.id
    )
  `;
}

function rowCountCte(): SQL {
  return sql`
    row_counts AS (
      SELECT
        (SELECT ${count()}::int FROM raw_seed) AS seeded_raw_rows,
        (SELECT ${count()}::int FROM selected_grains) AS selected_grains,
        (SELECT ${count()}::int FROM locked_raw) AS locked_raw_rows,
        (SELECT ${count()}::int FROM locked_hourly) AS locked_hourly_rows,
        (SELECT ${count()}::int FROM deleted_raw) AS raw_rows_deleted,
        (SELECT ${count()}::int FROM deleted_hourly) AS hourly_rows_deleted,
        (SELECT ${count()}::int FROM inserted_hourly) AS hourly_rows_inserted
    )
  `;
}

function productTotalCtes(): SQL {
  return sql`
    source_totals AS (
      SELECT
        COALESCE(SUM(quantity), 0)::numeric AS quantity,
        COALESCE(SUM(non_deduplicated_quantity), 0)::numeric AS non_deduplicated_quantity,
        COALESCE(SUM(credits_charged), 0)::numeric AS credits_charged,
        COALESCE(SUM(allowance_units), 0)::numeric AS allowance_units
      FROM source_facts
    ),
    inserted_totals AS (
      SELECT
        COALESCE(SUM(quantity), 0)::numeric AS quantity,
        COALESCE(SUM(non_deduplicated_quantity), 0)::numeric AS non_deduplicated_quantity,
        COALESCE(SUM(credits_charged), 0)::numeric AS credits_charged,
        COALESCE(SUM(allowance_units), 0)::numeric AS allowance_units
      FROM inserted_hourly
    )
  `;
}

function windowTotalCtes(): SQL {
  return sql`
    source_window_totals AS (
      SELECT
        source_windows.window_kind,
        source_windows.window_id,
        SUM(source_windows.allowance_units)::numeric AS allowance_units
      FROM (
        SELECT
          'short'::text AS window_kind,
          source_facts.short_window_id AS window_id,
          source_facts.allowance_units
        FROM source_facts
        WHERE source_facts.allowance_units > 0

        UNION ALL

        SELECT
          'weekly'::text AS window_kind,
          source_facts.weekly_window_id AS window_id,
          source_facts.allowance_units
        FROM source_facts
        WHERE source_facts.allowance_units > 0
      ) source_windows
      GROUP BY source_windows.window_kind, source_windows.window_id
    ),
    inserted_window_totals AS (
      SELECT
        inserted_windows.window_kind,
        inserted_windows.window_id,
        SUM(inserted_windows.allowance_units)::numeric AS allowance_units
      FROM (
        SELECT
          'short'::text AS window_kind,
          inserted_hourly.short_window_id AS window_id,
          inserted_hourly.allowance_units
        FROM inserted_hourly
        WHERE inserted_hourly.allowance_units > 0

        UNION ALL

        SELECT
          'weekly'::text AS window_kind,
          inserted_hourly.weekly_window_id AS window_id,
          inserted_hourly.allowance_units
        FROM inserted_hourly
        WHERE inserted_hourly.allowance_units > 0
      ) inserted_windows
      GROUP BY inserted_windows.window_kind, inserted_windows.window_id
    )
  `;
}

function windowReconciliationCte(): SQL {
  return sql`
    window_reconciliation AS (
      SELECT
        ${count()} FILTER (
          WHERE COALESCE(source_windows.window_kind, inserted_windows.window_kind) = 'short'
        )::int AS short_windows,
        ${count()} FILTER (
          WHERE COALESCE(source_windows.window_kind, inserted_windows.window_kind) = 'weekly'
        )::int AS weekly_windows,
        COALESCE(
          BOOL_AND(
            COALESCE(source_windows.allowance_units, 0)
              = COALESCE(inserted_windows.allowance_units, 0)
          ),
          true
        ) AS reconciled
      FROM source_window_totals source_windows
      FULL OUTER JOIN inserted_window_totals inserted_windows
        ON inserted_windows.window_kind = source_windows.window_kind
       AND inserted_windows.window_id = source_windows.window_id
    )
  `;
}

function compactionSummarySelect(): SQL {
  return sql`
    SELECT
      row_counts.seeded_raw_rows AS "seededRawRows",
      row_counts.selected_grains AS "selectedGrains",
      row_counts.raw_rows_deleted AS "rawRowsDeleted",
      row_counts.hourly_rows_deleted AS "hourlyRowsDeleted",
      row_counts.hourly_rows_inserted AS "hourlyRowsInserted",
      source_totals.quantity::text AS "quantity",
      source_totals.non_deduplicated_quantity::text AS "nonDeduplicatedQuantity",
      source_totals.credits_charged::text AS "creditsCharged",
      source_totals.allowance_units::text AS "allowanceUnits",
      window_reconciliation.short_windows AS "affectedShortWindows",
      window_reconciliation.weekly_windows AS "affectedWeeklyWindows",
      (
        source_totals.quantity = inserted_totals.quantity
        AND source_totals.non_deduplicated_quantity = inserted_totals.non_deduplicated_quantity
        AND source_totals.credits_charged = inserted_totals.credits_charged
        AND source_totals.allowance_units = inserted_totals.allowance_units
        AND window_reconciliation.reconciled
        AND row_counts.locked_raw_rows = row_counts.raw_rows_deleted
        AND row_counts.locked_hourly_rows = row_counts.hourly_rows_deleted
        AND row_counts.selected_grains = row_counts.hourly_rows_inserted
      ) AS "reconciled"
    FROM source_totals
    CROSS JOIN inserted_totals
    CROSS JOIN window_reconciliation
    CROSS JOIN row_counts
  `;
}

function compactUsageEventsSql(args: {
  readonly cutoff: string;
  readonly rawSeedLimit: number;
  readonly orgId: string | undefined;
}): SQL {
  return sql`
    WITH
    ${candidateCtes(args)},
    ${lockedSourceCtes(args.cutoff)},
    ${consolidatedSourceCtes()},
    ${mutationCtes()},
    ${rowCountCte()},
    ${productTotalCtes()},
    ${windowTotalCtes()},
    ${windowReconciliationCte()}
    ${compactionSummarySelect()}
  `;
}

async function loadCompactionCutoff(db: Pick<Db, "execute">): Promise<Date> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT (
        date_trunc('hour', timezone('UTC', statement_timestamp()))
        - interval '4 days'
      )::timestamp AS cutoff
    `,
    cutoffRowSchema,
  );
  const cutoff = rows[0]?.cutoff;
  if (!cutoff) {
    throw new Error("Usage event compaction cutoff query returned no row");
  }
  return cutoff;
}

async function loadHoldProbe(
  db: Pick<Db, "execute">,
  cutoff: string,
  rawSeedLimit: number,
  orgId: string | undefined,
): Promise<z.output<typeof holdProbeRowSchema>> {
  const rows = await executeRawRows(
    db,
    sql`
      WITH probed AS MATERIALIZED (
        SELECT event.billing_error
        FROM ${usageEvent} ${event}
        WHERE ${and(
          eq(event.status, sql`'processed'`),
          orgId === undefined ? undefined : eq(event.orgId, orgId),
          isNotNull(event.processedAt),
          lt(event.processedAt, sql`${cutoff}::timestamp`),
        )}
        ORDER BY ${oldestProcessedEventOrder}
        LIMIT ${rawSeedLimit}
      )
      SELECT
        ${count()}::int AS "probedRawRows",
        ${count()} FILTER (WHERE billing_error IS NOT NULL)::int
          AS "billingErrorHeldRows"
      FROM probed
    `,
    holdProbeRowSchema,
  );
  const probe = rows[0];
  if (!probe) {
    throw new Error(
      "Usage event compaction hold probe returned no summary row",
    );
  }
  return probe;
}

async function hasRemainingRawUsage(
  db: Pick<Db, "select">,
  cutoff: string,
  orgId: string | undefined,
): Promise<boolean> {
  const [remaining] = await db
    .select({ id: event.id })
    .from(event)
    .where(eligibleRawPredicate(cutoff, orgId))
    .limit(1);
  return remaining !== undefined;
}

async function compactUsageEventBatch(
  db: UsageEventCompactionDb,
  orgId: string | undefined,
  signal: AbortSignal,
): Promise<Omit<UsageEventCompactionStats, "durationMs">> {
  const rawSeedLimit = USAGE_EVENT_COMPACTION_RAW_SEED_LIMIT;
  return await db.transaction(async (tx) => {
    const lockStartedAt = performance.now();
    await lockUsageEventCompaction(tx);
    const lockWaitMs = Math.round(performance.now() - lockStartedAt);
    signal.throwIfAborted();

    const cutoffDate = await loadCompactionCutoff(tx);
    const cutoff = timestampWithoutTimeZone(cutoffDate);
    const holdProbe = await loadHoldProbe(tx, cutoff, rawSeedLimit, orgId);
    const rows = await executeRawRows(
      tx,
      compactUsageEventsSql({ cutoff, rawSeedLimit, orgId }),
      compactionRowSchema,
    );
    const compaction = rows[0];
    if (!compaction) {
      throw new Error("Usage event compaction returned no summary row");
    }
    if (!compaction.reconciled) {
      L.error("usage event compaction reconciliation failed", {
        cutoff: cutoffDate.toISOString(),
        rawSeedLimit,
        seededRawRows: compaction.seededRawRows,
        selectedGrains: compaction.selectedGrains,
        rawRowsDeleted: compaction.rawRowsDeleted,
        hourlyRowsDeleted: compaction.hourlyRowsDeleted,
        hourlyRowsInserted: compaction.hourlyRowsInserted,
      });
      throw new Error("Usage event compaction reconciliation failed");
    }
    signal.throwIfAborted();
    const hasMoreRaw = await hasRemainingRawUsage(tx, cutoff, orgId);
    signal.throwIfAborted();

    return {
      cutoff: cutoffDate.toISOString(),
      rawSeedLimit,
      seededRawRows: compaction.seededRawRows,
      selectedGrains: compaction.selectedGrains,
      probedRawRows: holdProbe.probedRawRows,
      billingErrorHeldRows: holdProbe.billingErrorHeldRows,
      rawRowsDeleted: compaction.rawRowsDeleted,
      hourlyRowsDeleted: compaction.hourlyRowsDeleted,
      hourlyRowsInserted: compaction.hourlyRowsInserted,
      quantity: compaction.quantity,
      nonDeduplicatedQuantity: compaction.nonDeduplicatedQuantity,
      creditsCharged: compaction.creditsCharged,
      allowanceUnits: compaction.allowanceUnits,
      affectedShortWindows: compaction.affectedShortWindows,
      affectedWeeklyWindows: compaction.affectedWeeklyWindows,
      reconciled: compaction.reconciled,
      hasMore: hasMoreRaw,
      lockWaitMs,
    };
  });
}

export const compactUsageEvents$ = command(
  async (
    { set },
    orgId: string | undefined,
    signal: AbortSignal,
  ): Promise<UsageEventCompactionStats> => {
    const startedAt = performance.now();
    const result = await compactUsageEventBatch(set(writeDb$), orgId, signal);
    const stats = {
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
    };
    const logicalInputRows = stats.rawRowsDeleted + stats.hourlyRowsDeleted;
    L.debug("usage event compaction completed", {
      ...stats,
      logicalInputRows,
      logicalCompressionRatio:
        stats.hourlyRowsInserted === 0
          ? null
          : logicalInputRows / stats.hourlyRowsInserted,
    });
    return stats;
  },
);
