import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

// Empty preparation schema. Only a verified server-side configuration can
// establish scope equivalence; this migration seeds no scope or activation.
export const xUsageBillingScopes = pgTable("x_usage_billing_scopes", {
  id: uuid("id").primaryKey(),
  activatedFromDay: date("activated_from_day"),
  closedThroughDay: date("closed_through_day"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// The consumer owns historical configuration verification and admission. A
// credential refresh for the same verified subject must reuse the scope ID.
export const xUsageRunBindings = pgTable(
  "x_usage_run_bindings",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => {
        return xUsageBillingScopes.id;
      }),
    // Non-secret serving configuration identity, never a credential/hash.
    configurationRevision: varchar("configuration_revision", {
      length: 128,
    }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
  },
  (table) => {
    return [
      unique("uq_x_usage_binding_run").on(table.id, table.runId),
      index("idx_x_usage_binding_run").on(table.runId),
      index("idx_x_usage_binding_org").on(table.orgId),
      index("idx_x_usage_binding_user").on(table.userId),
      index("idx_x_usage_binding_expiry").on(table.validUntil),
      check(
        "x_usage_binding_validity_check",
        sql`${table.validUntil} > ${table.validFrom} AND isfinite(${table.validFrom}) AND isfinite(${table.validUntil})`,
      ),
      check(
        "x_usage_binding_revision_check",
        sql`length(btrim(${table.configurationRevision})) > 0`,
      ),
    ];
  },
);

// Insert-only committed source outcomes. Ownership is inherited from the
// binding. No FK to compactable usage_event rows and no Q/K/R/reason counters.
export const xUsageObservationReceipts = pgTable(
  "x_usage_observation_receipts",
  {
    runId: uuid("run_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    bindingId: uuid("binding_id").notNull(),
    payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    utcDay: date("utc_day").notNull(),
    netQuantity: bigint("net_quantity", { mode: "number" }).notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.runId, table.sourceId] }),
      foreignKey({
        name: "x_usage_receipt_binding_run_fk",
        columns: [table.bindingId, table.runId],
        foreignColumns: [xUsageRunBindings.id, xUsageRunBindings.runId],
      }).onDelete("cascade"),
      index("idx_x_usage_receipt_binding").on(table.bindingId),
      index("idx_x_usage_receipt_day").on(table.utcDay),
      check(
        "x_usage_receipt_digest_check",
        sql`${table.payloadDigest} ~ '^[a-f0-9]{64}$'`,
      ),
      check(
        "x_usage_receipt_quantity_check",
        sql`${table.netQuantity} BETWEEN 0 AND 9007199254740991`,
      ),
      check(
        "x_usage_receipt_day_check",
        sql`isfinite(${table.observedAt}) AND ${table.utcDay} = (${table.observedAt} AT TIME ZONE 'UTC')::date`,
      ),
    ];
  },
);

// Global uniqueness has no organization/user/run partition and no personal
// cascade. Only bounded closed-day retention may remove these claims.
export const xUsageResourceClaims = pgTable(
  "x_usage_resource_claims",
  {
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => {
        return xUsageBillingScopes.id;
      }),
    utcDay: date("utc_day").notNull(),
    namespace: varchar("namespace", { length: 10 }).notNull(),
    resourceId: varchar("resource_id", { length: 32 }).notNull(),
  },
  (table) => {
    return [
      primaryKey({
        columns: [
          table.scopeId,
          table.utcDay,
          table.namespace,
          table.resourceId,
        ],
      }),
      index("idx_x_usage_claim_day").on(table.utcDay),
      check("x_usage_claim_day_check", sql`isfinite(${table.utcDay})`),
      check(
        "x_usage_claim_namespace_check",
        sql`${table.namespace} IN ('post', 'user')`,
      ),
      check(
        "x_usage_claim_id_check",
        sql`${table.resourceId} ~ '^[0-9]{1,32}$'`,
      ),
    ];
  },
);
