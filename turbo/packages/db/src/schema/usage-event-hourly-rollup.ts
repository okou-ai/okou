import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/** Hourly fragments of finalized usage, regrouped by product readers. */
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
    provider: text("provider").notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }).notNull(),
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
      ),
      index("idx_usage_event_hourly_rollup_run_id").on(table.runId),
      index("idx_usage_event_hourly_rollup_user_id").on(table.userId),
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
    ];
  },
);
