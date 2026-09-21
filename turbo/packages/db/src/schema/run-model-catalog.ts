import { boolean, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Operator-managed admission for adding new organization model policies.
 *
 * This is intentionally separate from model support, runtime admission, and
 * usage pricing. A disabled or missing row prevents only a new policy from
 * being added; existing policies remain usable and editable.
 */
export const runModelCatalog = pgTable("run_model_catalog", {
  model: varchar("model", { length: 255 }).primaryKey(),
  allowNewOrgPolicy: boolean("allow_new_org_policy").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
