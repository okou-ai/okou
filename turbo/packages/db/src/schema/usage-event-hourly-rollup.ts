import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";
import { orgUsageAllowanceWindows } from "./org-usage-allowance";

/**
 * Hourly rollups of finalized usage events.
 *
 * Product readers regroup across the nullable allowance-window pair. The pair
 * identifies only the allowance portion of a row and supports reconciliation
 * with retained source allocations before any later physical cleanup.
 */
export const usageEventHourlyRollup = pgTable(
  "usage_event_hourly_rollup",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    processedHour: timestamp("processed_hour").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    // Original identity survives run_id SET NULL. Missing historical context is
    // explicit; this is not an authorization reference or a pricing input yet.
    billingRunId: uuid("billing_run_id"),
    billingAnchorAt: timestamp("billing_anchor_at"),
    billingContext: text("billing_context").notNull().default("legacy_unknown"),
    kind: varchar("kind", { length: 30 }).notNull(),
    provider: varchar("provider", { length: 100 }).notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    shortWindowId: uuid("short_window_id"),
    weeklyWindowId: uuid("weekly_window_id"),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }).notNull(),
    allowanceUnits: bigint("allowance_units", { mode: "number" }).notNull(),
  },
  (table) => {
    return [
      index("idx_usage_event_hourly_rollup_billing_run").on(table.billingRunId),
      check(
        "usage_event_hourly_rollup_billing_context_check",
        sql`(
        (${table.billingContext} = 'run' AND ${table.billingRunId} IS NOT NULL AND ${table.billingAnchorAt} IS NOT NULL)
        OR (${table.billingContext} = 'runless' AND ${table.billingRunId} IS NULL AND ${table.billingAnchorAt} IS NOT NULL)
        OR (${table.billingContext} = 'pi_memory_stage1' AND ${table.billingRunId} IS NULL AND ${table.runId} IS NULL AND ${table.billingAnchorAt} IS NOT NULL AND ${table.kind} = 'model')
        OR (${table.billingContext} = 'missing_run' AND ${table.billingRunId} IS NOT NULL AND ${table.billingAnchorAt} IS NULL)
        OR (${table.billingContext} = 'legacy_unknown' AND ${table.billingRunId} IS NULL AND ${table.billingAnchorAt} IS NULL)
      )`,
      ),
      foreignKey({
        name: "fk_usage_event_hourly_rollup_short_window",
        columns: [table.shortWindowId],
        foreignColumns: [orgUsageAllowanceWindows.id],
      }),
      foreignKey({
        name: "fk_usage_event_hourly_rollup_weekly_window",
        columns: [table.weeklyWindowId],
        foreignColumns: [orgUsageAllowanceWindows.id],
      }),
      index("idx_usage_event_hourly_rollup_org_hour").on(
        table.orgId,
        table.processedHour,
      ),
      index("idx_usage_event_hourly_rollup_physical_grain").on(
        table.processedHour.desc(),
        table.orgId,
        table.userId,
        table.runId,
        table.kind,
        table.provider,
        table.category,
        table.shortWindowId,
        table.weeklyWindowId,
      ),
      index("idx_usage_event_hourly_rollup_run_id").on(table.runId),
      index("idx_usage_event_hourly_rollup_user_id").on(table.userId),
      index("idx_usage_event_hourly_rollup_short_window_id").on(
        table.shortWindowId,
      ),
      index("idx_usage_event_hourly_rollup_weekly_window_id").on(
        table.weeklyWindowId,
      ),
      check(
        "chk_usage_event_hourly_rollup_processed_hour",
        sql`${table.processedHour} = date_trunc('hour', ${table.processedHour})`,
      ),
      check(
        "chk_usage_event_hourly_rollup_quantity",
        sql`${table.quantity} >= 0`,
      ),
      check(
        "chk_usage_event_hourly_rollup_credits_charged",
        sql`${table.creditsCharged} >= 0`,
      ),
      check(
        "chk_usage_event_hourly_rollup_allowance_units",
        sql`${table.allowanceUnits} >= 0`,
      ),
      check(
        "chk_usage_event_hourly_rollup_allowance_window_pair",
        sql`(
          ${table.allowanceUnits} = 0
          AND ${table.shortWindowId} IS NULL
          AND ${table.weeklyWindowId} IS NULL
        ) OR (
          ${table.allowanceUnits} > 0
          AND ${table.shortWindowId} IS NOT NULL
          AND ${table.weeklyWindowId} IS NOT NULL
        )`,
      ),
    ];
  },
);
