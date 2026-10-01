import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageAllowanceAllocations } from "@okouai/db/schema/org-usage-allowance";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { command } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  parseRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { logger } from "../../lib/log";
import { timestampWithoutTimeZone } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { recordBillingOperationTimings } from "../external/sandbox-op-log";
import { safeSync } from "../utils";

const L = logger("CronCompactUsageEvents");
const USAGE_EVENT_COMPACTION_RAW_SEED_LIMIT = 500;
const event = alias(usageEvent, "event");
const allocation = alias(usageAllowanceAllocations, "allocation");

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
const safeCountSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

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
  maxGrainSourceRows: safeCountSchema,
  quantity: integerTextSchema,
  creditsCharged: integerTextSchema,
  allowanceUnits: integerTextSchema,
  affectedShortWindows: z.int(),
  affectedWeeklyWindows: z.int(),
  reconciled: z.boolean(),
  observedRunIds: z.array(z.uuid()).max(USAGE_EVENT_COMPACTION_RAW_SEED_LIMIT),
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

// Read bounded candidate identities. Ordinary mutation/FK checks arbitrate
// deletion; no parent or ledger rows are locked before the actual consumption.
function retainedIdentityCtes(args: {
  readonly cutoff: string;
  readonly rawSeedLimit: number;
  readonly orgId: string | undefined;
}): SQL {
  return sql`
    raw_candidates AS MATERIALIZED (
      SELECT event.id, event.run_id, event.billing_run_id, event.billing_context
      FROM ${usageEvent} ${event}
      WHERE ${eligibleRawPredicate(args.cutoff, args.orgId)}
      ORDER BY ${oldestProcessedEventOrder}
      LIMIT ${args.rawSeedLimit}
    ),
    retained_runs AS MATERIALIZED (
      SELECT id, org_id, user_id, created_at, trigger_source, chat_thread_id
      FROM ${agentRuns}
      WHERE id IN (
        SELECT COALESCE(billing_run_id, run_id) FROM raw_candidates
      )
      ORDER BY id
    ),
    retained_attributions AS MATERIALIZED (
      SELECT run_id, org_id, user_id, run_started_at
      FROM ${billingRunAttribution}
      WHERE run_id IN (
        SELECT COALESCE(candidate.billing_run_id, candidate.run_id)
        FROM raw_candidates candidate
        WHERE candidate.run_id IS NULL OR candidate.run_id IN (SELECT id FROM retained_runs)
      )
      ORDER BY run_id
    )
  `;
}

// Legacy raw facts may predate canonical capture. Populate only missing
// identities from this batch's retained live Runs; an existing canonical row
// remains authoritative even after content deletion. No timestamp round trip.
function capturedIdentityCtes(): SQL {
  return sql`
    captured_attributions AS (
      INSERT INTO ${billingRunAttribution} (
        run_id, org_id, user_id, run_started_at, source, thread_id, thread_context
      )
      SELECT id, org_id, user_id, created_at,
        CASE
          WHEN trigger_source = 'web' THEN 'chat'
          WHEN trigger_source IN ('automation-schedule', 'automation-event', 'goal') THEN 'automation'
          WHEN trigger_source IN ('slack', 'discord', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent') THEN trigger_source
          ELSE 'other'
        END,
        chat_thread_id,
        CASE WHEN chat_thread_id IS NULL THEN 'threadless' ELSE 'thread' END
      FROM retained_runs run
      WHERE NOT EXISTS (SELECT 1 FROM retained_attributions attribution WHERE attribution.run_id = run.id)
        AND EXISTS (
          SELECT 1 FROM deleted_raw consumed
          WHERE consumed.billing_run_id = run.id AND consumed.billing_context = 'run'
        )
      ORDER BY id
      ON CONFLICT (run_id) DO NOTHING
      RETURNING run_id, org_id, user_id, run_started_at
    )
  `;
}

function candidateCtes(args: {
  readonly cutoff: string;
  readonly rawSeedLimit: number;
  readonly orgId: string | undefined;
}): SQL {
  return sql`
    ${retainedIdentityCtes(args)},
    resolved_attributions AS MATERIALIZED (
      SELECT * FROM retained_attributions
      UNION ALL
      SELECT id AS run_id, org_id, user_id, created_at AS run_started_at
      FROM retained_runs run
      WHERE NOT EXISTS (
        SELECT 1 FROM retained_attributions attribution WHERE attribution.run_id = run.id
      )
    ),
    raw_seed AS MATERIALIZED (
      SELECT
        event.id,
        event::text AS observed_event,
        COALESCE(allocation.units_applied, 0)::bigint AS allowance_units,
        date_trunc('hour', event.processed_at)::timestamp AS processed_hour,
        event.org_id,
        event.user_id,
        event.run_id,
        COALESCE(event.billing_run_id, event.run_id) AS billing_run_id,
        CASE
          WHEN attribution.run_id IS NOT NULL THEN attribution.run_started_at
          WHEN COALESCE(event.billing_run_id, event.run_id) IS NULL
            AND event.billing_context IN ('runless', 'pi_memory_stage1') THEN event.billing_anchor_at
          ELSE NULL
        END AS billing_anchor_at,
        CASE
          WHEN attribution.run_id IS NOT NULL THEN 'run'
          WHEN COALESCE(event.billing_run_id, event.run_id) IS NOT NULL THEN 'missing_run'
          WHEN event.billing_context IN ('runless', 'pi_memory_stage1') THEN event.billing_context
          ELSE 'legacy_unknown'
        END AS billing_context,
        event.kind,
        event.provider,
        event.category,
        allocation.short_window_id,
        allocation.weekly_window_id,
        event.quantity,
        COALESCE(event.credits_charged, 0)::bigint AS credits_charged,
        (
          (event.run_id IS NULL OR event.billing_run_id IS NULL OR event.run_id = event.billing_run_id)
          AND CASE WHEN attribution.run_id IS NOT NULL THEN
            attribution.org_id = event.org_id AND attribution.user_id = event.user_id
            AND (event.billing_anchor_at IS NULL OR attribution.run_started_at = event.billing_anchor_at)
          ELSE event.billing_context <> 'run'
            AND NOT EXISTS (SELECT 1 FROM retained_runs run WHERE run.id = COALESCE(event.billing_run_id, event.run_id))
          END
        ) AS billing_identity_valid
      FROM ${usageEvent} ${event}
      INNER JOIN raw_candidates candidate ON candidate.id = event.id
      LEFT JOIN resolved_attributions attribution ON attribution.run_id = COALESCE(event.billing_run_id, event.run_id)
      LEFT JOIN ${usageAllowanceAllocations} ${allocation}
        ON ${eq(allocation.usageEventId, event.id)}
      WHERE ${eligibleRawPredicate(args.cutoff, args.orgId)}
        AND event.run_id IS NOT DISTINCT FROM candidate.run_id
        AND event.billing_run_id IS NOT DISTINCT FROM candidate.billing_run_id
        AND event.billing_context = candidate.billing_context
        AND (event.run_id IS NULL OR event.run_id IN (SELECT id FROM retained_runs))
        AND NOT EXISTS (
          SELECT 1 FROM ${agentRuns} live_run
          WHERE live_run.id = COALESCE(event.billing_run_id, event.run_id)
            AND live_run.id NOT IN (SELECT id FROM retained_runs)
        )
      ORDER BY ${oldestProcessedEventOrder}
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

// Only this bounded raw seed is consumed. Existing hourly fragments are immutable
// here; readers aggregate fragments by their business dimensions. Expanding a
// seed to an entire hour made one busy grain an unbounded transaction.
function consumedSourceCtes(): SQL {
  return sql`
    deleted_raw AS (
      DELETE FROM ${usageEvent} ${event}
      USING raw_seed
      WHERE event.id = raw_seed.id
        AND event.status = 'processed'
        AND event::text = raw_seed.observed_event
      RETURNING raw_seed.*
    ),
    ${capturedIdentityCtes()},
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
        event.credits_charged,
        event.allowance_units
      FROM deleted_raw event
      WHERE event.billing_context <> 'run'
        OR EXISTS (
          SELECT 1 FROM retained_attributions retained
          WHERE retained.run_id = event.billing_run_id
        )
        OR EXISTS (
          SELECT 1 FROM captured_attributions captured
          WHERE captured.run_id = event.billing_run_id
        )
    ),
    source_facts AS MATERIALIZED (
      SELECT
        ${physicalGrainColumns("locked_raw")},
        locked_raw.quantity::numeric AS quantity,
        locked_raw.credits_charged::numeric AS credits_charged,
        locked_raw.allowance_units::numeric AS allowance_units
      FROM locked_raw
    ),
    consolidated AS MATERIALIZED (
      SELECT
        ${physicalGrainColumns("source_facts")},
        SUM(source_facts.quantity) AS quantity,
        SUM(source_facts.credits_charged) AS credits_charged,
        SUM(source_facts.allowance_units) AS allowance_units,
        ${count()} AS source_rows
      FROM source_facts
      GROUP BY ${physicalGrainColumns("source_facts")}
    )
  `;
}

function mutationCtes(): SQL {
  return sql`
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
        credits_charged,
        allowance_units
      )
      SELECT
        ${physicalGrainColumns("consolidated")},
        consolidated.quantity,
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
        credits_charged,
        allowance_units
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
        (SELECT ${count()}::int FROM deleted_raw) AS raw_rows_deleted,
        0::int AS hourly_rows_deleted,
        (SELECT ${count()}::int FROM inserted_hourly) AS hourly_rows_inserted
    )
  `;
}

function productTotalCtes(): SQL {
  return sql`
    source_totals AS (
      SELECT
        COALESCE(SUM(quantity), 0)::numeric AS quantity,
        COALESCE(SUM(credits_charged), 0)::numeric AS credits_charged,
        COALESCE(SUM(allowance_units), 0)::numeric AS allowance_units
      FROM source_facts
    ),
    inserted_totals AS (
      SELECT
        COALESCE(SUM(quantity), 0)::numeric AS quantity,
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

// Reconcile only the bounded rows actually retained and consumed. Each batch
// appends independent fragments, which canonical product readers already
// regroup by their existing business dimensions.
function compactionSummarySelect(): SQL {
  return sql`
    SELECT
      row_counts.seeded_raw_rows AS "seededRawRows",
      row_counts.selected_grains AS "selectedGrains",
      row_counts.raw_rows_deleted AS "rawRowsDeleted",
      row_counts.hourly_rows_deleted AS "hourlyRowsDeleted",
      row_counts.hourly_rows_inserted AS "hourlyRowsInserted",
      COALESCE((SELECT MAX(source_rows) FROM consolidated), 0)::text
        AS "maxGrainSourceRows",
      source_totals.quantity::text AS "quantity",
      source_totals.credits_charged::text AS "creditsCharged",
      source_totals.allowance_units::text AS "allowanceUnits",
      window_reconciliation.short_windows AS "affectedShortWindows",
      window_reconciliation.weekly_windows AS "affectedWeeklyWindows",
      ARRAY(SELECT DISTINCT billing_run_id FROM inserted_hourly
            WHERE billing_context = 'run') AS "observedRunIds",
      (
        source_totals.quantity = inserted_totals.quantity
        AND source_totals.credits_charged = inserted_totals.credits_charged
        AND source_totals.allowance_units = inserted_totals.allowance_units
        AND window_reconciliation.reconciled
        AND row_counts.locked_raw_rows = row_counts.raw_rows_deleted
        AND row_counts.selected_grains >= row_counts.hourly_rows_inserted
        AND NOT EXISTS (SELECT 1 FROM raw_seed WHERE NOT billing_identity_valid)
        AND NOT EXISTS (
          SELECT 1 FROM deleted_raw consumed
          JOIN retained_runs run ON run.id = consumed.billing_run_id
          WHERE consumed.billing_context = 'run'
            AND NOT EXISTS (SELECT 1 FROM retained_attributions retained WHERE retained.run_id = run.id)
            AND NOT EXISTS (SELECT 1 FROM captured_attributions captured WHERE captured.run_id = run.id)
        )
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
    ${consumedSourceCtes()},
    ${mutationCtes()},
    ${rowCountCte()},
    ${productTotalCtes()},
    ${windowTotalCtes()},
    ${windowReconciliationCte()}
    ${compactionSummarySelect()}
  `;
}

function compactionHoldProbeSql(
  cutoff: string,
  rawSeedLimit: number,
  orgId: string | undefined,
): SQL {
  return sql`
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
      ${count()} FILTER (WHERE billing_error IS NOT NULL)::int AS "billingErrorHeldRows"
    FROM probed
  `;
}

const compactUsageEventBatch$ = command(
  async (
    { set },
    orgId: string | undefined,
    signal: AbortSignal,
  ): Promise<
    Omit<UsageEventCompactionStats, "durationMs"> & {
      readonly maxGrainSourceRows: number;
    }
  > => {
    const db = set(writeDb$);
    const rawSeedLimit = USAGE_EVENT_COMPACTION_RAW_SEED_LIMIT;
    return await db.transaction(async (tx) => {
      const lockWaitMs = 0;
      signal.throwIfAborted();

      const cutoffRows = parseRawRows(
        cutoffRowSchema,
        await tx.execute(sql`
      SELECT (date_trunc('hour', timezone('UTC', statement_timestamp()))
        - interval '4 days')::timestamp AS cutoff
    `),
      );
      const cutoffDate = cutoffRows[0]?.cutoff;
      if (!cutoffDate) {
        throw new Error("Usage event compaction cutoff query returned no row");
      }
      const cutoff = timestampWithoutTimeZone(cutoffDate);
      const [holdProbe] = parseRawRows(
        holdProbeRowSchema,
        await tx.execute(compactionHoldProbeSql(cutoff, rawSeedLimit, orgId)),
      );
      if (!holdProbe) {
        throw new Error(
          "Usage event compaction hold probe returned no summary row",
        );
      }
      const rows = parseRawRows(
        compactionRowSchema,
        await tx.execute(
          compactUsageEventsSql({ cutoff, rawSeedLimit, orgId }),
        ),
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
      if (compaction.observedRunIds.length > 0) {
        await tx
          .update(billingRunAttribution)
          .set({ usageObserved: true })
          .where(
            and(
              inArray(billingRunAttribution.runId, compaction.observedRunIds),
              eq(billingRunAttribution.usageObserved, false),
            ),
          );
      }
      signal.throwIfAborted();
      const [remaining] = await tx
        .select({ id: event.id })
        .from(event)
        .where(eligibleRawPredicate(cutoff, orgId))
        .limit(1);
      const hasMoreRaw = remaining !== undefined;
      signal.throwIfAborted();

      return {
        cutoff: cutoffDate.toISOString(),
        rawSeedLimit,
        seededRawRows: compaction.seededRawRows,
        selectedGrains: compaction.selectedGrains,
        maxGrainSourceRows: compaction.maxGrainSourceRows,
        probedRawRows: holdProbe.probedRawRows,
        billingErrorHeldRows: holdProbe.billingErrorHeldRows,
        rawRowsDeleted: compaction.rawRowsDeleted,
        hourlyRowsDeleted: compaction.hourlyRowsDeleted,
        hourlyRowsInserted: compaction.hourlyRowsInserted,
        quantity: compaction.quantity,
        creditsCharged: compaction.creditsCharged,
        allowanceUnits: compaction.allowanceUnits,
        affectedShortWindows: compaction.affectedShortWindows,
        affectedWeeklyWindows: compaction.affectedWeeklyWindows,
        reconciled: compaction.reconciled,
        hasMore: hasMoreRaw,
        lockWaitMs,
      };
    });
  },
);

export const compactUsageEvents$ = command(
  async (
    { set },
    orgId: string | undefined,
    signal: AbortSignal,
  ): Promise<UsageEventCompactionStats> => {
    const startedAt = performance.now();
    const { maxGrainSourceRows, ...batch } = await set(
      compactUsageEventBatch$,
      orgId,
      signal,
    );

    const stats = {
      ...batch,
      durationMs: Math.round(performance.now() - startedAt),
    };
    const logicalInputRows = stats.rawRowsDeleted + stats.hourlyRowsDeleted;
    // The batch has committed; telemetry failure cannot make its response
    // ambiguous. Cancellation still propagates via safeSync.
    safeSync(() => {
      recordBillingOperationTimings([
        {
          actionType: "api_billing_usage_compaction_batch",
          durationMs: stats.durationMs,
          success: true,
          dimensions: {
            raw_seed_limit: stats.rawSeedLimit,
            seeded_raw_rows: stats.seededRawRows,
            selected_grains: stats.selectedGrains,
            raw_rows_deleted: stats.rawRowsDeleted,
            hourly_rows_deleted: stats.hourlyRowsDeleted,
            hourly_rows_inserted: stats.hourlyRowsInserted,
            billing_error_held_rows: stats.billingErrorHeldRows,
            logical_input_rows: logicalInputRows,
            max_grain_source_rows: maxGrainSourceRows,
            logical_compression_ratio:
              stats.hourlyRowsInserted === 0
                ? null
                : logicalInputRows / stats.hourlyRowsInserted,
            has_more: stats.hasMore,
          },
        },
        {
          actionType: "api_billing_usage_compaction_lock_wait",
          durationMs: stats.lockWaitMs,
          success: true,
        },
      ]);
    });
    return stats;
  },
);
