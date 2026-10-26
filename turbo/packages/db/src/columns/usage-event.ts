import { uuid, varchar, text, bigint, timestamp } from "drizzle-orm/pg-core";

/** Canonical usage columns shared by application and migration mappings. */
export function usageEventColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id"),
    idempotencyKey: uuid("idempotency_key").notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // Original identity survives run_id SET NULL. Missing historical context is
    // explicit. Publication validates ownership; settlement resolves the captured
    // credit policy through the retained billing attribution.
    billingRunId: uuid("billing_run_id"),
    billingAnchorAt: timestamp("billing_anchor_at"),
    billingContext: text("billing_context").notNull().default("legacy_unknown"),
    kind: varchar("kind", { length: 30 }).notNull(),
    provider: text("provider").notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    creditsCharged: bigint("credits_charged", { mode: "number" }),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    billingError: varchar("billing_error", { length: 50 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    processedAt: timestamp("processed_at"),
  };
}
