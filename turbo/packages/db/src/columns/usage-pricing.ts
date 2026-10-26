import { uuid, varchar, text, bigint, timestamp } from "drizzle-orm/pg-core";

/** Canonical pricing columns shared by application and migration mappings. */
export function usagePricingColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: varchar("kind", { length: 30 }).notNull(),
    provider: text("provider").notNull(),
    category: varchar("category", { length: 100 }).notNull(),
    unitPrice: bigint("unit_price", { mode: "number" }).notNull(),
    unitSize: bigint("unit_size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
