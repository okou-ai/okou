import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Global run model catalog: one row per stable model ID.
 *
 * `replaced_by` NULL marks an active model. A non-NULL value marks a retired
 * model whose stored selections resolve to that replacement. The composite
 * foreign key `(replaced_by, replacement_target_active)` →
 * `(model, is_active)` only matches active rows, so every replacement target
 * exists, is active, and is not the row itself: chains are a single hop and
 * cannot cycle. Retiring a target requires repointing its referrers first
 * (same transaction).
 *
 * `is_system_default` marks the one model new organizations and unresolved
 * selections start from. At most one row can be the default and it must be
 * active; "exactly one" and "has an enabled Built-in route" are validated by
 * the API catalog loader. Switch the default by clearing the old row before
 * setting the new one inside one transaction.
 *
 * Transitional: `allow_new_org_policy` still gates adding a new organization
 * policy for code-active models (see docs/model-catalog.md). It is dropped
 * once readers switch to `replaced_by`.
 */
export const runModelCatalog = pgTable(
  "run_model_catalog",
  {
    model: varchar("model", { length: 255 }).primaryKey(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    isSystemDefault: boolean("is_system_default").notNull().default(false),
    replacedBy: varchar("replaced_by", { length: 255 }),
    isActive: boolean("is_active")
      .notNull()
      .generatedAlwaysAs(sql`replaced_by IS NULL`),
    // NULL for active rows (MATCH SIMPLE skips the FK), true otherwise.
    replacementTargetActive: boolean(
      "replacement_target_active",
    ).generatedAlwaysAs(
      sql`CASE WHEN replaced_by IS NULL THEN NULL ELSE true END`,
    ),
    allowNewOrgPolicy: boolean("allow_new_org_policy").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_run_model_catalog_model_active").on(
        table.model,
        table.isActive,
      ),
      foreignKey({
        name: "fk_run_model_catalog_replaced_by_active",
        columns: [table.replacedBy, table.replacementTargetActive],
        foreignColumns: [table.model, table.isActive],
      }),
      uniqueIndex("idx_run_model_catalog_one_system_default")
        .on(table.isSystemDefault)
        .where(sql`${table.isSystemDefault}`),
      check(
        "chk_run_model_catalog_default_active",
        sql`NOT ${table.isSystemDefault} OR ${table.replacedBy} IS NULL`,
      ),
    ];
  },
);
