import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentRuns } from "./agent-run";
import { usageEvent } from "./usage-event";

/**
 * Retired Allowance archive. Keep issuance, window and allocation records for
 * historical accounting and privacy deletion; serving code never grants,
 * refreshes or consumes these entitlements. No destructive migration is planned.
 */
export const orgUsageAllowanceEntitlements = pgTable(
  "org_usage_allowance_entitlements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    source: varchar("source", { length: 50 }).notNull().default("manual"),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    shortWindowSeconds: integer("short_window_seconds").notNull(),
    shortWindowUnits: bigint("short_window_units", {
      mode: "number",
    }).notNull(),
    weeklyWindowSeconds: integer("weekly_window_seconds")
      .notNull()
      .default(604_800),
    weeklyWindowUnits: bigint("weekly_window_units", {
      mode: "number",
    }).notNull(),
    effectiveAt: timestamp("effective_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_org_usage_allowance_entitlements_org").on(table.orgId),
      index("idx_org_usage_allowance_entitlements_status").on(table.status),
      index("idx_org_usage_allowance_entitlements_stripe_subscription").on(
        table.stripeSubscriptionId,
      ),
      check(
        "chk_org_usage_allowance_short_window_seconds",
        sql`${table.shortWindowSeconds} > 0`,
      ),
      check(
        "chk_org_usage_allowance_short_window_units",
        sql`${table.shortWindowUnits} > 0`,
      ),
      check(
        "chk_org_usage_allowance_weekly_window_seconds",
        sql`${table.weeklyWindowSeconds} > 0`,
      ),
      check(
        "chk_org_usage_allowance_weekly_window_units",
        sql`${table.weeklyWindowUnits} > 0`,
      ),
      check(
        "chk_org_usage_allowance_entitlement_time",
        sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.effectiveAt}`,
      ),
    ];
  },
);

export const orgUsageAllowanceWindows = pgTable(
  "org_usage_allowance_windows",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    entitlementId: uuid("entitlement_id")
      .notNull()
      .references(
        () => {
          return orgUsageAllowanceEntitlements.id;
        },
        { onDelete: "cascade" },
      ),
    kind: varchar("kind", { length: 20 }).notNull(),
    startsAt: timestamp("starts_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    unitLimit: bigint("unit_limit", { mode: "number" }).notNull(),
    consumedUnits: bigint("consumed_units", { mode: "number" })
      .notNull()
      .default(0),
    createdByRunId: uuid("created_by_run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Window creation identity: concurrent creators anchored at the same
      // instant converge through INSERT … ON CONFLICT instead of a row lock.
      uniqueIndex("uq_org_usage_allowance_windows_entitlement_kind_starts").on(
        table.entitlementId,
        table.kind,
        table.startsAt,
      ),
      index("idx_org_usage_allowance_windows_org_kind_starts").on(
        table.orgId,
        table.kind,
        table.startsAt.desc(),
      ),
      index("idx_org_usage_allowance_windows_org_kind_expires").on(
        table.orgId,
        table.kind,
        table.expiresAt,
      ),
      check(
        "chk_org_usage_allowance_windows_kind",
        sql`${table.kind} IN ('short', 'weekly')`,
      ),
      check(
        "chk_org_usage_allowance_windows_limit",
        sql`${table.unitLimit} > 0`,
      ),
      check(
        "chk_org_usage_allowance_windows_consumed",
        sql`${table.consumedUnits} >= 0`,
      ),
      check(
        "chk_org_usage_allowance_windows_time",
        sql`${table.expiresAt} > ${table.startsAt}`,
      ),
    ];
  },
);

export const usageAllowanceAllocations = pgTable(
  "usage_allowance_allocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    usageEventId: uuid("usage_event_id")
      .notNull()
      .references(
        () => {
          return usageEvent.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    runId: uuid("run_id").references(
      () => {
        return agentRuns.id;
      },
      { onDelete: "set null" },
    ),
    shortWindowId: uuid("short_window_id")
      .notNull()
      .references(
        () => {
          return orgUsageAllowanceWindows.id;
        },
        { onDelete: "cascade" },
      ),
    weeklyWindowId: uuid("weekly_window_id")
      .notNull()
      .references(
        () => {
          return orgUsageAllowanceWindows.id;
        },
        { onDelete: "cascade" },
      ),
    unitsApplied: bigint("units_applied", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_usage_allowance_allocations_usage_event").on(
        table.usageEventId,
      ),
      index("idx_usage_allowance_allocations_org").on(table.orgId),
      index("idx_usage_allowance_allocations_run").on(table.runId),
      check(
        "chk_usage_allowance_allocations_units",
        sql`${table.unitsApplied} > 0`,
      ),
    ];
  },
);
