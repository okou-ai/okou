import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/** Content-free reconciliation identity; deliberately independent of content FKs.
 * A run with no incurred or outstanding billing obligation is provisional, not
 * permanently retained evidence. See docs/database/billing-attribution.md.
 */
export const billingRunAttribution = pgTable(
  "billing_run_attribution",
  {
    runId: uuid("run_id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runStartedAt: timestamp("run_started_at").notNull(),
    source: text("source").notNull(),
    // Monotone evidence marker; identity fields remain immutable. A raw event's
    // normal compaction or existing teardown cannot make billed work provisional.
    usageObserved: boolean("usage_observed").notNull().default(false),
    capturedAt: timestamp("captured_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_billing_run_attribution_owner").on(
        table.orgId,
        table.userId,
        table.runId,
      ),
      check(
        "billing_run_attribution_source_check",
        sql`${table.source} IN ('chat', 'automation', 'slack', 'teams', 'telegram', 'email', 'agentphone', 'github', 'agent', 'other')`,
      ),
    ];
  },
);

/** Temporary operator checkpoint, removed after its report is accepted. */
export const billingAttributionBackfill = pgTable(
  "billing_attribution_backfill",
  {
    id: uuid("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id"),
    runFrom: uuid("run_from"),
    runThrough: uuid("run_through"),
    phase: text("phase").notNull().default("runs"),
    cursor: uuid("cursor"),
    scanned: bigint("scanned", { mode: "number" }).notNull().default(0),
    populated: bigint("populated", { mode: "number" }).notNull().default(0),
    missingSource: bigint("missing_source", { mode: "number" })
      .notNull()
      .default(0),
    conflicts: bigint("conflicts", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "billing_attribution_backfill_phase_check",
        sql`${table.phase} IN ('runs', 'jobs', 'raw', 'hourly', 'done')`,
      ),
    ];
  },
);
